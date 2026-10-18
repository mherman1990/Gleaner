// The ledger turns per-page extraction into durable open loops.
//  1. Same-page items are updated in place (existing_item_id) so re-transcribing an edited page never duplicates.
//  2. Number-based closes ("✓14") update earlier items.
//  3. Genuinely new items are checked against all open loops and the page's own earlier items (Haiku) — a match means
//     he rewrote/carried it, which bumps carry_days instead of creating a duplicate. carry_days is the "you keep
//     carrying this" signal.
// Every change here is an event by "handwriting" (an item erased from its page: "erased"); see changeItem() in db.js.
import { db, newId, nextCode, J, P, setItemStatus, openItems, changeItem, recordEvent } from '../db.js';
import { config, normTime } from '../config.js';
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
function refreshItem(id, it, pageDate, r) {
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
  const newDeadline = due !== cur.due || dueTime !== cur.due_time; // fresh nudges for it, as for a hand edit
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
  if ((it.status === 'done' || it.status === 'dropped') && cur.status !== it.status) setItemStatus(id, it.status, 'handwriting', 'checked on page');
}

/** Items erased from their page lately (dropped by "erased"): a line for one written on another page is it, moved. */
function recentlyErased() {
  return db.prepare(`SELECT id, code, text, person, status FROM items WHERE status='dropped' AND closed_by='erased' AND closed_at >= ?
    ORDER BY code`).all(movedSince());
}

/**
 * Which new lines are the same commitment as an existing item. Candidates: the open and snoozed items, and this page's
 * (pageItems: its lines, and the items it closed or snoozed); items erased from a page in the last few hours (a line
 * cut from one page and pasted on another, or struck through and rewritten, is the same item moved); and, when a new
 * line is ticked, this page's done and dropped ones: a ticked line read again without its id is that item, not a new
 * one. A line that isn't ticked never matches a done or dropped item, erased ones aside: writing a done task again is
 * a new commitment. Returns new line index → item id.
 */
async function matchExisting(candidates, excludeIds, pageItems) {
  const ticked = (c) => isClosed(c.status);
  const pool = new Map([...openItems(), ...db.prepare(`SELECT * FROM items WHERE status='snoozed' ORDER BY code`).all()].map((o) => [o.id, o]));
  for (const o of pageItems) if (!isClosed(o.status) || candidates.some(ticked)) pool.set(o.id, o);
  for (const o of recentlyErased()) pool.set(o.id, { ...o, erased: true });
  const existing = [...pool.values()].filter((o) => !excludeIds.has(o.id));
  if (!candidates.length || !existing.length) return new Map();
  const label = (x) => `${x.text}${x.person ? ` [${x.person}]` : ''}`;
  const kind = (o) => (o.erased ? 'ERASED' : isClosed(o.status) ? 'CLOSED' : 'OPEN');
  const content = `${candidates.map((c, i) => `NEW n${i}: ${label(c)}${ticked(c) ? ' (ticked)' : ''}`).join('\n')}\n\n${
    existing.map((o) => `${kind(o)} ${o.code}: ${label(o)}`).join('\n')}`;
  const res = await callStructured(structuredParams({ model: config.llm.triageModel, systemBlocks: [DEDUPE_SYSTEM], content, schema: MATCH_SCHEMA }), 'dedupe');
  const byCode = new Map(existing.map((o) => [o.code, o]));
  const out = new Map();
  for (const m of res.matches || []) {
    const idx = Number(String(m.new_ref).replace(/^n/, ''));
    const o = byCode.get(m.code);
    if (o && candidates[idx] && !out.has(idx) && (ticked(candidates[idx]) || !isClosed(o.status) || o.erased)) out.set(idx, o.id);
  }
  return out;
}

/**
 * Apply one page's transcription (shaped by RECORD_PAGE_SCHEMA). Returns a short summary for logging, plus what
 * changed so the caller can regenerate the right markdown: prevDate (the page's old date, if it moved) and
 * itemIds (every item touched). r is the registry to map tags and names with: the ingest run's, so a page is
 * applied with the registry its prompt had; the current one by default.
 */
export async function applyPageResult(pageRow, result, fallbackDate, r = currentRegistry()) {
  const pageDate = isDate(result.page_date) ? result.page_date : fallbackDate;
  const items = (result.items || []).filter((raw) => raw?.text?.trim()).map((raw) => normalize(raw, r));
  // An item dropped long ago because its line left this page isn't brought back by a line linked to it now: that's
  // the task written again (a recurring one, say), a new item.
  const stale = (id) => {
    const cur = db.prepare('SELECT status, closed_by, closed_at FROM items WHERE id=?').get(id);
    return cur?.status === 'dropped' && cur.closed_by === 'erased' && cur.closed_at < movedSince();
  };
  const own = priorItemsForPage(pageRow.id).filter((p) => !stale(p.id));
  const priorIds = new Set(own.map((p) => p.id));
  // Items this page closed or snoozed without a line of its own for them.
  const closedHere = new Map(closedOnPage(pageRow.id).filter((i) => !priorIds.has(i.id)).map((i) => [i.id, i]));
  const same = items.filter((it) => priorIds.has(it.existing_item_id));
  const unlinked = items.filter((it) => !same.includes(it));
  // A ticked line with the very words of a done or dropped item of this page (one of its lines, or one it closed) is
  // that item read again without its id. Matched here rather than by the dedupe, so an open item with the same words
  // (this week's copy of a recurring task) isn't closed in its place.
  const reread = new Map();
  for (const it of unlinked) {
    if (!isClosed(it.status)) continue;
    const hit = [...own, ...closedHere.values()].find((o) => isClosed(o.status) && sameLine(o, it) && ![...reread.values()].includes(o.id));
    if (hit) reread.set(it, hit.id);
  }
  const fresh = unlinked.filter((it) => !reread.has(it));

  // Carry-forward detection for new items, before anything is written: if the call fails, the page stays as it was
  // and is read again next run. This page's own earlier items are candidates too, so one the model re-extracted
  // without existing_item_id (or reworded) matches and keeps its number instead of being dropped as "erased" and
  // re-created under a new one, and a ticked line doesn't become a second, done copy of the item it closed.
  const matches = await matchExisting(fresh, new Set([...same.map((it) => it.existing_item_id), ...reread.values()]),
    [...own, ...closedHere.values()]);

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
    const prior = priorItemsForPage(pageRow.id);
    const touched = new Set();
    // An item dropped lately because its line was erased (older ones never get here: see stale and recentlyErased),
    // whose line is here now (moved, or rewritten): open again, with fresh nudges, unless the line is ticked, which
    // refreshItem applies.
    const reopenIfErased = (id, it) => {
      const cur = db.prepare('SELECT status, closed_by FROM items WHERE id=?').get(id);
      if (cur.status !== 'dropped' || cur.closed_by !== 'erased' || isClosed(it.status)) return;
      setItemStatus(id, 'open', 'handwriting');
      db.prepare('UPDATE items SET last_nudged=NULL, nudge_count=0 WHERE id=?').run(id);
    };
    // The ticked line of an item this page closed, read again: the page already closed it, so nothing changes.
    const closedTick = (id) => {
      const cur = db.prepare('SELECT status, closed_by FROM items WHERE id=?').get(id);
      return closedHere.has(id) && isClosed(cur?.status) && cur.closed_by !== 'erased';
    };
    for (const it of [...same, ...[...reread].map(([line, id]) => ({ ...line, existing_item_id: id }))]) {
      if (closedTick(it.existing_item_id)) continue;
      reopenIfErased(it.existing_item_id, it);
      refreshItem(it.existing_item_id, it, pageDate, r);
      mention(it.existing_item_id, pageRow.id, pageDate);
      touched.add(it.existing_item_id);
    }
    let created = 0, carried = 0;
    fresh.forEach((it, idx) => {
      const existing = matches.get(idx);
      if (existing && closedTick(existing)) return;
      if (existing) {
        reopenIfErased(existing, it);
        refreshItem(existing, it, pageDate, r); mention(existing, pageRow.id, pageDate); touched.add(existing);
        if (!priorIds.has(existing)) carried++;
      } else { touched.add(insertItem(it, pageRow.id, pageDate)); created++; }
    });

    // A line no longer on the page was erased (or moved) on the tablet: its mention is marked gone, and an open item
    // with no line left on any page is dropped. Mentions are kept, so the sensitivity filter still sees where it was.
    for (const p of prior) {
      if (touched.has(p.id)) continue;
      db.prepare('UPDATE item_mentions SET gone_at=? WHERE item_id=? AND page_id=? AND gone_at IS NULL').run(new Date().toISOString(), p.id, pageRow.id);
      if (p.status !== 'open') continue;
      const others = db.prepare('SELECT COUNT(*) AS n FROM item_mentions WHERE item_id=? AND page_id<>? AND gone_at IS NULL').get(p.id, pageRow.id).n;
      if (!others) { setItemStatus(p.id, 'dropped', 'erased', 'no longer on source page'); touched.add(p.id); }
    }

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
