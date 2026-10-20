// The ledger turns per-page extraction into durable open loops.
//  1. Same-page items are updated in place (existing_item_id) so re-transcribing an edited page never duplicates.
//  2. Number-based closes ("✓14") update earlier items.
//  3. Genuinely new items are checked against all open loops, the page's own earlier items and items whose line just
//     left another page (Haiku) — a match means he rewrote, carried or moved it, which bumps carry_days instead of
//     creating a duplicate. carry_days is the "you keep carrying this" signal.
//  4. A line no longer on a page is marked gone there; an open item with no line left on any page is dropped.
// The rules for which item a line is are at applyPageResult.
//  5. Items API clients create (upsertCandidate, through src/adapters/api-inbox.js) are checked against the open loops
//     the same way: a match fills the existing item's empty fields instead of adding a copy.
// Every change here is an event by "handwriting" (an item erased from its page: "erased"), or by the API client;
// see changeItem() in db.js.
import { db, newId, nextCode, J, P, setItemStatus, openItems, changeItem, recordEvent } from '../db.js';
import { config, normTime, localDate } from '../config.js';
import { currentRegistry, canonicalTags, resolvePerson, isFirstNameOf } from '../registry.js';
import { callStructured, structuredParams } from '../llm/client.js';
import { DEDUPE_SYSTEM, MATCH_SCHEMA } from '../llm/prompts.js';

const VALID = new Set(['action', 'followup', 'waiting', 'decision', 'idea', 'question']);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isClosed = (status) => status === 'done' || status === 'dropped';
// A line erased from one page and written on another within this many hours (the same sync, or the next one) is the
// same item, moved. Longer, and a task erased when done and written again the next day would be one item for ever.
export const MOVED_WITHIN_HOURS = 6;
const movedSince = () => new Date(Date.now() - MOVED_WITHIN_HOURS * 3600e3).toISOString();

// One writer at a time: a page apply and an API create each decide after a dedupe call, so without this one could
// add an item the other's call never saw. In-process only, like the job lock (src/jobs.js).
let ledgerQueue = Promise.resolve();
function withLedger(fn) {
  const run = ledgerQueue.then(fn, fn);
  ledgerQueue = run.catch(() => {});
  return run;
}

/**
 * The items that have had a line on this page (its mentions, including lines marked gone): the ones the prompt lists
 * and a re-read updates. Erasing their line drops an open one that has no line left on any page.
 */
export function priorItemsForPage(pageId) {
  return db.prepare(`SELECT i.id, i.code, i.text, i.person, i.status FROM items i JOIN item_mentions m ON m.item_id = i.id
    WHERE m.page_id = ? ORDER BY i.code`).all(pageId);
}

/**
 * The items this page closed or snoozed, by number or by ticking a line for them (page_closes). The prompt doesn't
 * list them (the model would read "✓14" back as item 14's line); a ticked line read again for one is matched in code
 * and by the dedupe instead, and changes nothing about it but a tick.
 */
export function closedOnPage(pageId) {
  return db.prepare(`SELECT id, code, text, person, status FROM items WHERE id IN (SELECT item_id FROM page_closes WHERE page_id = ?)
    ORDER BY code`).all(pageId);
}

// The words of an item, for telling the same line from another: case, spacing and punctuation don't count.
const words = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const sameLine = (a, b) => words(a.text) === words(b.text) && (!a.person || !b.person || words(a.person) === words(b.person));

/** The item's line on this page, as this read found it: ticked or struck (status), or neither. */
function mention(itemId, pageId, pageDate, status) {
  // Upsert: a re-transcription can move the page to another date (e.g. a date written in later); a line back on the
  // page isn't gone any more. linked_at stays when the line was first linked to the page; mark is this read's.
  db.prepare(`INSERT INTO item_mentions (item_id, page_id, page_date, linked_at, mark) VALUES (?,?,?,?,?)
    ON CONFLICT(item_id, page_id) DO UPDATE SET page_date=excluded.page_date, gone_at=NULL, mark=excluded.mark`)
    .run(itemId, pageId, pageDate, new Date().toISOString(), isClosed(status) ? status : null);
  const days = db.prepare('SELECT COUNT(DISTINCT page_date) AS n FROM item_mentions WHERE item_id=?').get(itemId).n;
  changeItem(itemId, 'handwriting', () => db.prepare(`UPDATE items SET carry_days=?, last_page_id=?, last_seen=MAX(COALESCE(last_seen,''), ?) WHERE id=?`)
    .run(Math.max(1, days), pageId, pageDate, itemId));
}

/** The due date and time the model read. A time with no date written means the page date. */
function dueOf(it, pageDate) {
  const time = normTime(it.due_time);
  const due = isDate(it.due) ? it.due : time ? pageDate : null;
  return { due, due_time: due ? time : null };
}

/**
 * The model's item, mapped onto the registry: aliases become canonical tags and a known name becomes the full name.
 * The model is asked to do the same, but this is what's stored. A first name shared by two registry people stays
 * as written; person_ambiguous is worked out from the stored names whenever an item is returned (personAmbiguous).
 */
function normalize(it, r = currentRegistry()) {
  return { ...it, tags: canonicalTags(it.tags, r), person: resolvePerson(it.person, r).name, assignee: resolvePerson(it.assignee, r).name };
}

function insertItem(it, pageId, pageDate) {
  const id = newId('it');
  const { due, due_time } = dueOf(it, pageDate);
  db.transaction(() => { // the number, the row and its "created" event together
    const code = nextCode();
    db.prepare(`INSERT INTO items (id, code, text, kind, person, assignee, due, due_time, priority, tags, status,
      first_page_id, last_page_id, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, code, it.text.trim(), VALID.has(it.kind) ? it.kind : 'action', it.person || null, it.assignee || null,
      due, due_time, it.priority ? 1 : 0, J(it.tags), 'open', pageId, pageId, pageDate, pageDate);
    recordEvent('handwriting', code, 'created', null, it.text.trim());
  }).immediate();
  if (it.status === 'done' || it.status === 'dropped') setItemStatus(id, it.status, 'handwriting', 'marked on source page');
  mention(id, pageId, pageDate, it.status);
  return id;
}

/**
 * Re-read or carried item. A value the model didn't find keeps the old one, and a field edited by hand is kept.
 * prevMark is how its line on this page was read last time (see mention()).
 */
function refreshItem(id, it, pageDate, r, dated = true, prevMark = null) {
  const cur = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  const hand = new Set(P(cur.edited));
  const read = dueOf(it, pageDate);
  const keepDue = hand.has('due') || hand.has('due_time') || !read.due;
  // A name stays when this read has none or it was set by hand. When this read is only the stored registry person's
  // first name ("Alex" after "Alex Two", or after "Alex T" stored before the registry), that person stays, in full.
  // Another person's name replaces it.
  const name = (field) => {
    if (hand.has(field) || !it[field]) return cur[field];
    return isFirstNameOf(it[field], cur[field], r) ? resolvePerson(cur[field], r).name : it[field];
  };
  const due = keepDue ? cur.due : read.due;
  const dueTime = keepDue ? cur.due_time : read.due_time;
  // Fresh nudges for a new deadline, as for a hand edit. Not for a time written without a date on a page with no
  // written date: that date (the notebook's last change) moves on every read.
  const newDeadline = (dated || isDate(it.due)) && (due !== cur.due || dueTime !== cur.due_time);
  changeItem(id, 'handwriting', () => db.prepare(`UPDATE items SET text=@text, person=@person, assignee=@assignee,
    due=@due, due_time=@due_time, priority=@priority, tags=@tags${newDeadline ? ', last_nudged=NULL, nudge_count=0' : ''} WHERE id=@id`).run({
    id,
    text: hand.has('text') ? cur.text : it.text.trim(),
    person: name('person'),
    assignee: name('assignee'),
    due,
    due_time: dueTime,
    priority: Math.max(cur.priority, it.priority ? 1 : 0),
    tags: J([...new Set([...it.tags, ...P(cur.api_tags)])]), // the page's tags, and any an API client gave it
  }));
  // Ticked or struck on the page; not again for a line read so before, which a person may have reopened since. A
  // struck line also makes final a drop that was only its line leaving a page.
  if (isClosed(it.status) && ((prevMark !== it.status && cur.status !== it.status) || (it.status === 'dropped' && cur.closed_by === 'erased'))) {
    setItemStatus(id, it.status, 'handwriting', 'checked on page');
  }
}

/**
 * Items whose line left a page in the last few hours (MOVED_WITHIN_HOURS): a line for one on another page is it,
 * moved. That includes open items dropped because the line left their last page ("erased").
 */
function recentlyMoved() {
  return db.prepare(`SELECT DISTINCT i.id, i.code, i.text, i.person, i.status, i.closed_by FROM items i
    JOIN item_mentions m ON m.item_id = i.id WHERE m.gone_at >= ? ORDER BY i.code`).all(movedSince());
}

const erasedDrop = (o) => o.status === 'dropped' && o.closed_by === 'erased';

/**
 * Which new lines are the same commitment as an existing item: line index → item id. Candidates, by label:
 * - OPEN: the open loops, this page's open and snoozed items, and open or snoozed items whose line left a page in the
 *   last few hours (a line cut from one page and pasted on another is the same item, moved). Any line may match.
 * - ERASED: items dropped in the last few hours because their line left their last page: moved, too. Any line.
 * - CLOSED: this page's done and dropped items, and those it closed. Only a ticked line, and before an OPEN one: a
 *   ticked line read again without its id is that item.
 * - OTHER: done or dropped items whose line left a page lately (a ticked line moved), and snoozed items (ticked off
 *   on another page). Only a ticked line, and only when nothing above fits.
 * CLOSED and OTHER are offered only when a new line is ticked (or struck). An unticked line never matches a done
 * item: writing a done task again is a new commitment. A line the model matched to more than one item takes the
 * first by that order.
 */
async function matchExisting(candidates, excludeIds, pageItems, { moves = true } = {}) {
  const ticked = (c) => isClosed(c.status);
  const anyTicked = candidates.some(ticked);
  const pool = new Map(); // lowest precedence first: a later label for the same item replaces an earlier one
  const put = (o, kind) => { if (kind) pool.set(o.id, { ...o, kind }); };
  if (anyTicked) for (const o of db.prepare(`SELECT * FROM items WHERE status='snoozed'`).all()) put(o, 'OTHER');
  if (moves) for (const o of recentlyMoved()) put(o, erasedDrop(o) ? 'ERASED' : !isClosed(o.status) ? 'OPEN' : anyTicked && 'OTHER');
  for (const o of openItems()) put(o, 'OPEN');
  // An item of the page dropped lately because its line left another page is still ERASED: moved here, maybe.
  for (const o of pageItems) put(o, pool.get(o.id)?.kind === 'ERASED' ? 'ERASED' : !isClosed(o.status) ? 'OPEN' : anyTicked && 'CLOSED');
  const existing = [...pool.values()].filter((o) => !excludeIds.has(o.id)).sort((a, b) => a.code - b.code);
  if (!candidates.length || !existing.length) return new Map();
  const label = (x) => `${x.text}${x.person ? ` [${x.person}]` : ''}`;
  const content = `${candidates.map((c, i) => `NEW n${i}: ${label(c)}${ticked(c) ? ' (ticked)' : ''}`).join('\n')}\n\n${
    existing.map((o) => `${o.kind} ${o.code}: ${label(o)}`).join('\n')}`;
  const res = await callStructured(structuredParams({ model: config.llm.triageModel, systemBlocks: [DEDUPE_SYSTEM], content, schema: MATCH_SCHEMA }), 'dedupe');
  const byCode = new Map(existing.map((o) => [o.code, o]));
  const rank = (c, o) => (ticked(c) ? { CLOSED: 0, OPEN: 1, ERASED: 1, OTHER: 2 } : { OPEN: 0, ERASED: 0 })[o.kind];
  const best = new Map();
  for (const m of res.matches || []) {
    const idx = Number(String(m.new_ref).replace(/^n/, ''));
    const o = byCode.get(m.code);
    const k = o && candidates[idx] ? rank(candidates[idx], o) : undefined;
    if (k !== undefined && !(best.get(idx)?.k <= k)) best.set(idx, { id: o.id, k });
  }
  return new Map([...best].map(([idx, b]) => [idx, b.id]));
}

/**
 * The item a line was written from, when the line is that task written again but became another item: kept for the
 * sensitivity filter, so restricted work written again stays hidden however the registry or the pages change later.
 */
const addSource = (itemId, sourceId) => db.prepare('INSERT OR IGNORE INTO item_sources (item_id, source_id) VALUES (?, ?)').run(itemId, sourceId);

/** Live (not gone) mentions of an item: on this page, and on any other. */
const liveOn = (itemId, pageId) => !!db.prepare('SELECT 1 FROM item_mentions WHERE item_id=? AND page_id=? AND gone_at IS NULL').get(itemId, pageId);
const liveElsewhere = (itemId, pageId) => db.prepare('SELECT COUNT(*) AS n FROM item_mentions WHERE item_id=? AND page_id<>? AND gone_at IS NULL').get(itemId, pageId).n > 0;

/**
 * The lines of this page's items that this read didn't find are gone from it: mark each mention gone, and drop (as
 * "erased") an open item, or one whose snooze is over, that has no line left on any page. Only a line that was there
 * until now counts: an item reopened by hand after its line left isn't dropped again by the next read. Only a
 * handwritten item is dropped: one an API client created (an email's task, later written down) outlives its line.
 */
function linesGone(pageId, touched) {
  const today = localDate();
  for (const p of db.prepare(`SELECT i.id, i.status, i.snooze_until, i.source FROM items i JOIN item_mentions m ON m.item_id = i.id
    WHERE m.page_id = ? AND m.gone_at IS NULL`).all(pageId)) {
    if (touched.has(p.id)) continue;
    db.prepare('UPDATE item_mentions SET gone_at=? WHERE item_id=? AND page_id=?').run(new Date().toISOString(), p.id, pageId);
    const due = p.source === 'handwriting' && (p.status === 'open' || (p.status === 'snoozed' && p.snooze_until <= today));
    if (due && !liveElsewhere(p.id, pageId)) { setItemStatus(p.id, 'dropped', 'erased', 'no longer on source page'); touched.add(p.id); }
  }
}

/**
 * Snoozed items whose last line was erased while they slept: once the snooze is over, they're dropped (as "erased"),
 * as an open item would have been. Items that were never on a page, or an API client created, aren't touched.
 * Returns the items it dropped.
 */
export function dropErasedSnoozes(today = localDate()) {
  return db.transaction(() => {
    const ids = db.prepare(`SELECT i.id FROM items i WHERE i.status='snoozed' AND i.snooze_until <= ? AND i.source='handwriting'
      AND EXISTS (SELECT 1 FROM item_mentions m WHERE m.item_id=i.id)
      AND NOT EXISTS (SELECT 1 FROM item_mentions m WHERE m.item_id=i.id AND m.gone_at IS NULL)`).all(today).map((r) => r.id);
    for (const id of ids) setItemStatus(id, 'dropped', 'erased', 'no longer on source page');
    return ids;
  }).immediate();
}

/** A page now blank, or deleted on the tablet: every line on it is gone. Returns the items it dropped. */
export function pageEmptied(pageId) {
  return db.transaction(() => { const touched = new Set(); linesGone(pageId, touched); return [...touched]; }).immediate();
}

/**
 * Apply one page's transcription (shaped by RECORD_PAGE_SCHEMA). Returns a short summary for logging, plus what
 * changed so the caller can regenerate the right markdown: prevDate (the page's old date, if it moved) and
 * itemIds (every item touched). r is the registry to map tags and names with: the ingest run's, so a page is
 * applied with the registry its prompt had; the current one by default.
 *
 * Which item a line is:
 * 1. A line linked (existing_item_id) to an item whose line is on this page now is that line, read again. Unless the
 *    item is closed and its line, read ticked or struck last time, is now neither: the old line was erased and the
 *    task written again (or its tick erased), a new commitment (3). A line linked to an item dropped in the last few
 *    hours because its line left is that line too: it's back (moved back, or a read missed it), and the item opens
 *    again. One linked to any other item whose line left this page is the task written again (3): a done task written
 *    again is a new commitment, even if a read had only missed its line.
 * 2. Otherwise, a ticked or struck line with the very words of an unlinked item on this page, or of a done item this
 *    page closed, is that item (matched in code, so this week's open copy of a recurring task on another page isn't
 *    closed in its place). An open item of the page comes first: it's the one just ticked.
 * 3. Every other line goes to the dedupe (matchExisting): carried, moved, or new. A struck line that matches nothing
 *    is nothing: the writer cancelled it before it was an item. A line written again (1) that becomes a new item, or
 *    is matched to another one, records the item it was written from (item_sources), so restricted work written again
 *    stays restricted.
 * 4. A ticked or struck line ends only that line, changing nothing about its item, when:
 *    - it's a ticked line of an item this page closed (the page closed it already);
 *    - it's a struck line of an item whose line has moved from this page to another (its old line, read again);
 *    - it's a struck line of an item with a line on another page linked after this one (carried or written again
 *      there): this is the old copy, struck when the task moved on. Striking the newest line cancels the task.
 * A tick or strike already read on a line isn't applied again: a person may have reopened the item since. Nor is a
 * close by number this page already made.
 */
export function applyPageResult(pageRow, result, fallbackDate, r = currentRegistry()) {
  return withLedger(() => applyPage(pageRow, result, fallbackDate, r));
}

async function applyPage(pageRow, result, fallbackDate, r) {
  const dated = isDate(result.page_date);
  const pageDate = dated ? result.page_date : fallbackDate;
  const items = (result.items || []).filter((raw) => raw?.text?.trim()).map((raw) => normalize(raw, r));
  const prior = priorItemsForPage(pageRow.id);
  const priorById = new Map(prior.map((p) => [p.id, p]));
  const mentions = new Map(db.prepare('SELECT item_id, gone_at, mark FROM item_mentions WHERE page_id=?').all(pageRow.id).map((m) => [m.item_id, m]));
  const live = new Set(prior.filter((p) => !mentions.get(p.id)?.gone_at).map((p) => p.id));
  const lineBack = (id) => {
    const gone = mentions.get(id)?.gone_at;
    const cur = gone && db.prepare('SELECT status, closed_by FROM items WHERE id=?').get(id);
    return !!cur && erasedDrop(cur) && gone >= movedSince();
  };
  const writtenAgain = (it) => isClosed(priorById.get(it.existing_item_id)?.status) && !!mentions.get(it.existing_item_id)?.mark && !isClosed(it.status);
  // Items this page closed or snoozed without a line of its own for them.
  const closedHere = new Map(closedOnPage(pageRow.id).filter((i) => !priorById.has(i.id)).map((i) => [i.id, i]));
  const same = items.filter((it) => (live.has(it.existing_item_id) && !writtenAgain(it)) || lineBack(it.existing_item_id));
  const linked = new Set(same.map((it) => it.existing_item_id));
  const reread = new Map();
  for (const it of items) {
    if (same.includes(it) || !isClosed(it.status)) continue;
    const taken = (o) => linked.has(o.id) || [...reread.values()].includes(o.id);
    const ownLive = prior.filter((o) => live.has(o.id) && !taken(o) && sameLine(o, it));
    const hit = ownLive.find((o) => !isClosed(o.status)) ?? ownLive[0]
      ?? [...closedHere.values()].find((o) => isClosed(o.status) && !taken(o) && sameLine(o, it));
    if (hit) reread.set(it, hit.id);
  }
  const fresh = items.filter((it) => !same.includes(it) && !reread.has(it));

  // Carry-forward detection for new items, before anything is written: if the call fails, the page stays as it was
  // and is read again next run.
  const matches = await matchExisting(fresh, new Set([...linked, ...reread.values()]),
    [...prior.filter((o) => live.has(o.id)), ...closedHere.values()]);

  // Then everything at once, under the write lock: no reader sees the page's new text without its items (which the
  // sensitivity filter goes by), and every decision uses the rows as they are now, not as before the call.
  const pageTags = canonicalTags(result.tags, r);
  return db.transaction(() => {
    const prevDate = db.prepare('SELECT page_date FROM pages WHERE id=?').get(pageRow.id)?.page_date || null;
    db.prepare(`UPDATE pages SET status='transcribed', transcribed_hash=rm_hash, page_date=?, summary=?, tags=?, transcription_md=?,
      legibility=?, uncertain=?, batch_id=NULL, error=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(pageDate, result.summary || '', J(pageTags), result.transcription_md || '', result.legibility || null, J(result.uncertain_spans), pageRow.id);
    // Every tag the page has been read with is kept: a later read that misses a restricted one doesn't unhide it.
    for (const t of pageTags) db.prepare('INSERT OR IGNORE INTO page_tags (page_id, tag) VALUES (?, ?)').run(pageRow.id, t);
    const touched = new Set();
    const row = (id) => db.prepare('SELECT status, closed_by FROM items WHERE id=?').get(id);
    // The ticked line of an item this page closed, read again: the page already closed it.
    const closedTick = (id) => closedHere.has(id) && isClosed(row(id)?.status) && row(id).closed_by !== 'erased';
    // A struck line of an item whose line left this page and is now on another (its old line, moved, read again
    // here): the item is where its line is now. A tick, though, is a tick: a read may only have missed the line.
    const movedAway = (id, it) => it.status === 'dropped' && priorById.has(id) && !liveOn(id, pageRow.id) && liveElsewhere(id, pageRow.id);
    // A struck line of an item with a line on another page linked after this one (in the same instant: added after):
    // its old copy (rule 4).
    const oldCopy = (id, it) => it.status === 'dropped' && !!db.prepare(`SELECT 1 FROM item_mentions o WHERE o.item_id=? AND o.page_id<>?
      AND o.gone_at IS NULL AND (o.linked_at, o.rowid) > (SELECT linked_at, rowid FROM item_mentions WHERE item_id=? AND page_id=?)`).get(id, pageRow.id, id, pageRow.id);
    const endsOnly = (id, it) => closedTick(id) || movedAway(id, it) || oldCopy(id, it);
    const apply = (id, it) => {
      // An item dropped because its line left its page, whose line is here now (moved): open again, unless the line is
      // ticked, which refreshItem applies.
      const cur = row(id);
      if (erasedDrop(cur) && !isClosed(it.status)) setItemStatus(id, 'open', 'handwriting');
      const prevMark = db.prepare('SELECT mark FROM item_mentions WHERE item_id=? AND page_id=?').get(id, pageRow.id)?.mark;
      refreshItem(id, it, pageDate, r, dated, prevMark);
      mention(id, pageRow.id, pageDate, it.status);
      touched.add(id);
    };
    // A line that ends only itself isn't touched, so linesGone below marks it gone from this page.
    for (const it of same) if (!endsOnly(it.existing_item_id, it)) apply(it.existing_item_id, it);
    for (const [it, id] of reread) if (!endsOnly(id, it)) apply(id, it);
    let created = 0, carried = 0;
    fresh.forEach((it, idx) => {
      const existing = matches.get(idx);
      const from = priorById.has(it.existing_item_id) ? it.existing_item_id : null; // written again here (rule 1)
      if (existing && endsOnly(existing, it)) return;
      if (existing) {
        apply(existing, it);
        if (from && from !== existing) addSource(existing, from);
        if (!priorById.has(existing)) carried++;
        return;
      }
      if (it.status === 'dropped') return; // struck before it was ever an item: cancelled
      const id = insertItem(it, pageRow.id, pageDate);
      if (from) addSource(id, from);
      touched.add(id); created++;
    });

    linesGone(pageRow.id, touched);

    // Number-based closes / snoozes. The page names each item it acts on without mentioning it, so the link is kept
    // in page_closes: a page that closes restricted work is hidden from clients that may not see it. Links are only
    // added, and a close is made only on the read that links it: a re-read doesn't undo a person's reopen or snooze
    // since, nor move a snooze whose relative date ("→ Fri") now reads as next week.
    let closed = 0;
    for (const c of result.closes || []) {
      const item = db.prepare('SELECT id, status, closed_by FROM items WHERE code=?').get(c.code);
      if (!item) continue;
      if (!db.prepare('INSERT OR IGNORE INTO page_closes (page_id, item_id) VALUES (?, ?)').run(pageRow.id, item.id).changes) continue;
      // An item only dropped because its line left a page is still the writer's to close: the close wins over a move.
      if (item.status === 'done' || (item.status === 'dropped' && item.closed_by !== 'erased')) continue;
      if (c.action === 'snooze' && isDate(c.snooze_until)) setItemStatus(item.id, 'snoozed', 'handwriting', c.evidence, c.snooze_until);
      else if (c.action === 'done' || c.action === 'dropped') { setItemStatus(item.id, c.action, 'handwriting', c.evidence); closed++; }
      else continue;
      touched.add(item.id);
    }

    return { pageDate, prevDate, created, carried, closed, itemIds: [...touched] };
  }).immediate();
}

/**
 * An item an API client asked for (src/adapters/api-inbox.js), checked against the open loops like a new handwritten
 * line. Returns { result, code, id }:
 * - "existing": this source and source_ref were sent before (an item from them, or one an earlier request with them
 *   merged into, whatever its status now): nothing changes.
 * - "merged": the dedupe matched an open item. Its empty fields (due date and time, person, assignee) are filled,
 *   unless Matt set or cleared them by hand; the new tags are added (and kept across page re-reads, as api_tags);
 *   priority only goes up. Its text, kind and source stay.
 * - "created": a new open item, with source and source_ref, and no page.
 * dryRun answers "existing", "would_create" or "would_merge", and writes nothing. hidden(): the item ids the dedupe
 * may not match (those the client may not see), worked out once this request has its turn. inboxId: the request's own
 * inbox row, left out of the source_ref lookup.
 */
export function upsertCandidate(raw, { client, source, sourceRef = null, dryRun = false, hidden = () => new Set(), inboxId = null, r = currentRegistry() }) {
  return withLedger(async () => {
    const it = normalize({ kind: 'action', status: 'open', person: null, assignee: null, due: null, due_time: null, priority: false, tags: [], ...raw }, r);
    const prior = () => {
      if (sourceRef === null) return null;
      return db.prepare('SELECT id, code FROM items WHERE source=? AND source_ref=?').get(source, sourceRef)
        ?? db.prepare(`SELECT i.id, i.code FROM inbox x JOIN items i ON i.code = x.item_code WHERE x.source=? AND x.source_ref=? AND x.status='done'
          AND x.id IS NOT ? ORDER BY x.id LIMIT 1`).get(source, sourceRef, inboxId);
    };
    const found = prior();
    if (found) return { result: 'existing', code: found.code, id: found.id };
    const match = (await matchExisting([it], hidden(), [], { moves: false })).get(0);
    const target = match && db.prepare('SELECT id, code FROM items WHERE id=?').get(match);
    if (dryRun) return target ? { result: 'would_merge', code: target.code, id: target.id } : { result: 'would_create', code: null, id: null };
    return db.transaction(() => {
      const again = prior(); // sent twice at once: the first one made it
      if (again) return { result: 'existing', code: again.code, id: again.id };
      const today = localDate();
      const { due, due_time } = dueOf(it, today);
      // The match as it is now: an item closed or snoozed while the dedupe call was out isn't merged into.
      const cur = target && db.prepare('SELECT * FROM items WHERE id=?').get(target.id);
      if (cur && (cur.status === 'open' || (cur.status === 'snoozed' && cur.snooze_until <= today))) {
        const hand = new Set(P(cur.edited));
        const handDue = hand.has('due') || hand.has('due_time');
        const tags = [...new Set([...P(cur.tags), ...it.tags])];
        changeItem(cur.id, client, () => db.prepare(`UPDATE items SET due=@due, due_time=@due_time, person=@person, assignee=@assignee,
          priority=@priority, tags=@tags, api_tags=@api_tags WHERE id=@id`).run({
          id: cur.id,
          due: handDue ? cur.due : cur.due ?? due,
          due_time: handDue || cur.due ? cur.due_time : due_time,
          person: hand.has('person') ? cur.person : cur.person ?? (it.person || null),
          assignee: hand.has('assignee') ? cur.assignee : cur.assignee ?? (it.assignee || null),
          priority: Math.max(cur.priority, it.priority ? 1 : 0),
          tags: J(tags),
          api_tags: J([...new Set([...P(cur.api_tags), ...it.tags])]),
        }));
        return { result: 'merged', code: cur.code, id: cur.id };
      }
      const id = newId('it');
      const code = nextCode();
      db.prepare(`INSERT INTO items (id, code, text, kind, person, assignee, due, due_time, priority, tags, api_tags, status, source, source_ref,
        first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, code, it.text.trim(), VALID.has(it.kind) ? it.kind : 'action', it.person || null, it.assignee || null,
        due, due_time, it.priority ? 1 : 0, J(it.tags), J(it.tags), 'open', source, sourceRef, today, today);
      recordEvent(client, code, 'created', null, it.text.trim());
      return { result: 'created', code, id };
    }).immediate();
  });
}

export const itemTags = (i) => P(i.tags);
