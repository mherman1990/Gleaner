// The ledger turns per-page extraction into durable open loops.
//  1. Same-page items are updated in place (existing_item_id) so re-transcribing an edited page never duplicates.
//  2. Number-based closes ("✓14") update earlier items.
//  3. Genuinely new items are checked against all open loops, the page's own earlier items and items whose line just
//     left another page (Haiku) — a match means he rewrote, carried or moved it, which bumps carry_days instead of
//     creating a duplicate. carry_days is the "you keep carrying this" signal.
//  4. A line no longer on a page is marked gone there; an open item with no line left on any page is dropped.
// Every change here is an event by "handwriting" (an item erased from its page: "erased"); see changeItem() in db.js.
import { db, newId, nextCode, J, P, setItemStatus, openItems, changeItem, recordEvent } from '../db.js';
import { config, normTime, localDate } from '../config.js';
import { currentRegistry, canonicalTags, resolvePerson, isFirstNameOf, tagKey } from '../registry.js';
import { callStructured, structuredParams } from '../llm/client.js';
import { DEDUPE_SYSTEM, MATCH_SCHEMA } from '../llm/prompts.js';

const VALID = new Set(['action', 'followup', 'waiting', 'decision', 'idea', 'question']);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isClosed = (status) => status === 'done' || status === 'dropped';
// A line erased from one page and written on another within this many hours (the same sync, or the next one) is the
// same item, moved. Longer, and a task erased when done and written again the next day would be one item for ever.
export const MOVED_WITHIN_HOURS = 6;
const movedSince = () => new Date(Date.now() - MOVED_WITHIN_HOURS * 3600e3).toISOString();

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

function mention(itemId, pageId, pageDate) {
  // Upsert: a re-transcription can move the page to another date (e.g. a date written in later); a line back on the
  // page isn't gone any more.
  db.prepare(`INSERT INTO item_mentions (item_id, page_id, page_date) VALUES (?,?,?)
    ON CONFLICT(item_id, page_id) DO UPDATE SET page_date=excluded.page_date, gone_at=NULL`).run(itemId, pageId, pageDate);
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
  mention(id, pageId, pageDate);
  return id;
}

/** Re-read or carried item. A value the model didn't find keeps the old one, and a field edited by hand is kept. */
function refreshItem(id, it, pageDate, r, dated = true) {
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
    tags: J(it.tags),
  }));
  // Ticked or struck on the page. A struck line also makes final a drop that was only its line leaving a page.
  if (isClosed(it.status) && (cur.status !== it.status || (it.status === 'dropped' && cur.closed_by === 'erased'))) {
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
 * - OTHER: done or dropped items whose line left another page lately (a ticked line moved), and snoozed items (ticked
 *   off on another page). Only a ticked line, and only when nothing above fits.
 * CLOSED and OTHER are offered only when a new line is ticked. An unticked line never matches a done item: writing a
 * done task again is a new commitment.
 */
async function matchExisting(candidates, excludeIds, pageItems) {
  const ticked = (c) => isClosed(c.status);
  const anyTicked = candidates.some(ticked);
  const pool = new Map(); // lowest precedence first: a later label for the same item replaces an earlier one
  const put = (o, kind) => { if (kind) pool.set(o.id, { ...o, kind }); };
  if (anyTicked) for (const o of db.prepare(`SELECT * FROM items WHERE status='snoozed'`).all()) put(o, 'OTHER');
  for (const o of recentlyMoved()) put(o, erasedDrop(o) ? 'ERASED' : !isClosed(o.status) ? 'OPEN' : anyTicked && 'OTHER');
  for (const o of openItems()) put(o, 'OPEN');
  for (const o of pageItems) put(o, !isClosed(o.status) ? 'OPEN' : anyTicked && 'CLOSED');
  const existing = [...pool.values()].filter((o) => !excludeIds.has(o.id)).sort((a, b) => a.code - b.code);
  if (!candidates.length || !existing.length) return new Map();
  const label = (x) => `${x.text}${x.person ? ` [${x.person}]` : ''}`;
  const content = `${candidates.map((c, i) => `NEW n${i}: ${label(c)}${ticked(c) ? ' (ticked)' : ''}`).join('\n')}\n\n${
    existing.map((o) => `${o.kind} ${o.code}: ${label(o)}`).join('\n')}`;
  const res = await callStructured(structuredParams({ model: config.llm.triageModel, systemBlocks: [DEDUPE_SYSTEM], content, schema: MATCH_SCHEMA }), 'dedupe');
  const byCode = new Map(existing.map((o) => [o.code, o]));
  const out = new Map();
  for (const m of res.matches || []) {
    const idx = Number(String(m.new_ref).replace(/^n/, ''));
    const o = byCode.get(m.code);
    if (o && candidates[idx] && !out.has(idx) && (o.kind === 'OPEN' || o.kind === 'ERASED' || ticked(candidates[idx]))) out.set(idx, o.id);
  }
  return out;
}

/**
 * The tags a new item takes from the item its line was written from: that item's tags, and any restricted project it
 * ever had (its tag events) or was written on (page_tags of its pages), so restricted work written again stays hidden.
 */
function inheritedTags(id, r) {
  const x = db.prepare('SELECT code, tags FROM items WHERE id=?').get(id);
  const restricted = new Set((r?.projects ?? []).filter((p) => p.sensitivity === 'restricted').map((p) => tagKey(p.tag)));
  const history = db.prepare(`SELECT old, new FROM events WHERE item_code=? AND field='tags'`).all(x.code).flatMap((e) => [...P(e.old), ...P(e.new)]);
  const pages = db.prepare('SELECT t.tag FROM page_tags t JOIN item_mentions m ON m.page_id=t.page_id WHERE m.item_id=?').all(id).map((t) => t.tag);
  return [...canonicalTags(P(x.tags), r), ...canonicalTags([...history, ...pages], r).filter((t) => restricted.has(tagKey(t)))];
}

/** Live (not gone) mentions of an item: on this page, and on any other. */
const liveOn = (itemId, pageId) => !!db.prepare('SELECT 1 FROM item_mentions WHERE item_id=? AND page_id=? AND gone_at IS NULL').get(itemId, pageId);
const liveElsewhere = (itemId, pageId) => db.prepare('SELECT COUNT(*) AS n FROM item_mentions WHERE item_id=? AND page_id<>? AND gone_at IS NULL').get(itemId, pageId).n > 0;

/**
 * The lines of this page's items that this read didn't find are gone from it: mark each mention gone, and drop (as
 * "erased") an open item, or one whose snooze is over, that has no line left on any page. Only a line that was there
 * until now counts: an item reopened by hand after its line left isn't dropped again by the next read.
 */
function linesGone(pageId, touched) {
  const today = localDate();
  for (const p of db.prepare(`SELECT i.id, i.status, i.snooze_until FROM items i JOIN item_mentions m ON m.item_id = i.id
    WHERE m.page_id = ? AND m.gone_at IS NULL`).all(pageId)) {
    if (touched.has(p.id)) continue;
    db.prepare('UPDATE item_mentions SET gone_at=? WHERE item_id=? AND page_id=?').run(new Date().toISOString(), p.id, pageId);
    const due = p.status === 'open' || (p.status === 'snoozed' && p.snooze_until <= today);
    if (due && !liveElsewhere(p.id, pageId)) { setItemStatus(p.id, 'dropped', 'erased', 'no longer on source page'); touched.add(p.id); }
  }
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
 * 1. A line linked (existing_item_id) to an item whose line is on this page now is that line, read again. So is one
 *    linked to an item dropped in the last few hours because its line left: the line is back (moved back, or a read
 *    missed it), and the item opens again. One linked to any other item whose line left this page is the task
 *    written again: a done task written again is a new commitment, even if a read had only missed its line.
 * 2. Otherwise, a ticked line with the very words of an unlinked item on this page, or of a done item this page
 *    closed, is that item (matched in code, so this week's open copy of a recurring task on another page isn't closed
 *    in its place). An open item of the page comes first: it's the one just ticked.
 * 3. Every other line goes to the dedupe (matchExisting): carried, moved, or new. A line linked to an item whose line
 *    left this page earlier is one of these: written again here. If it's new, it keeps that item's tags and any
 *    restricted project it ever had or was written on, so a restricted task written again stays restricted.
 * 4. A ticked line matched to an item this page closed changes nothing, and so does a struck line matched to an item
 *    whose line has moved from this page to another (its old line, read again).
 */
export async function applyPageResult(pageRow, result, fallbackDate, r = currentRegistry()) {
  const dated = isDate(result.page_date);
  const pageDate = dated ? result.page_date : fallbackDate;
  const items = (result.items || []).filter((raw) => raw?.text?.trim()).map((raw) => normalize(raw, r));
  const prior = priorItemsForPage(pageRow.id);
  const priorById = new Map(prior.map((p) => [p.id, p]));
  const mentions = new Map(db.prepare('SELECT item_id, gone_at FROM item_mentions WHERE page_id=?').all(pageRow.id).map((m) => [m.item_id, m.gone_at]));
  const live = new Set(prior.filter((p) => !mentions.get(p.id)).map((p) => p.id));
  const lineBack = (id) => {
    const gone = mentions.get(id);
    const cur = gone && db.prepare('SELECT status, closed_by FROM items WHERE id=?').get(id);
    return !!cur && erasedDrop(cur) && gone >= movedSince();
  };
  // Items this page closed or snoozed without a line of its own for them.
  const closedHere = new Map(closedOnPage(pageRow.id).filter((i) => !priorById.has(i.id)).map((i) => [i.id, i]));
  const same = items.filter((it) => live.has(it.existing_item_id) || lineBack(it.existing_item_id));
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
    const apply = (id, it) => {
      // An item dropped because its line left its page, whose line is here now (moved): open again, unless the line is
      // ticked, which refreshItem applies.
      const cur = row(id);
      if (erasedDrop(cur) && !isClosed(it.status)) setItemStatus(id, 'open', 'handwriting');
      refreshItem(id, it, pageDate, r, dated);
      mention(id, pageRow.id, pageDate);
      touched.add(id);
    };
    for (const it of same) apply(it.existing_item_id, it);
    for (const [it, id] of reread) if (!closedTick(id)) apply(id, it);
    let created = 0, carried = 0;
    fresh.forEach((it, idx) => {
      const existing = matches.get(idx);
      if (existing && (closedTick(existing) || movedAway(existing, it))) return;
      if (existing) {
        apply(existing, it);
        if (!priorById.has(existing)) carried++;
        return;
      }
      // New. A line linked to an item of this page whose line left it keeps that item's tags and restriction.
      const tags = priorById.has(it.existing_item_id) ? [...new Set([...it.tags, ...inheritedTags(it.existing_item_id, r)])] : it.tags;
      touched.add(insertItem({ ...it, tags }, pageRow.id, pageDate)); created++;
    });

    linesGone(pageRow.id, touched);

    // Number-based closes / snoozes. The page names each item it acts on without mentioning it, so the link is kept
    // in page_closes: a page that closes restricted work is hidden from clients that may not see it. Links are only
    // added: a re-read can't repeat a close (the item is no longer open), and the ink that made it is still there.
    let closed = 0;
    for (const c of result.closes || []) {
      const item = db.prepare('SELECT id, status, closed_by FROM items WHERE code=?').get(c.code);
      if (!item) continue;
      db.prepare('INSERT OR IGNORE INTO page_closes (page_id, item_id) VALUES (?, ?)').run(pageRow.id, item.id);
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

export const itemTags = (i) => P(i.tags);
