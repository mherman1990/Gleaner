// The ledger turns per-page extraction into durable open loops.
//  1. Same-page items are updated in place (existing_item_id) so re-transcribing an edited page never duplicates.
//  2. Number-based closes ("✓14") update earlier items.
//  3. Genuinely new items are checked against all open loops (Haiku) — a match means he rewrote/carried it,
//     which bumps carry_days instead of creating a duplicate. carry_days is the "you keep carrying this" signal.
// Every change here is an event by "handwriting" (an item erased from its page: "erased"); see changeItem() in db.js.
import { db, newId, nextCode, J, P, setItemStatus, openItems, changeItem, recordEvent } from '../db.js';
import { config, normTime } from '../config.js';
import { currentRegistry, canonicalTags, resolvePerson, isFirstNameOf } from '../registry.js';
import { callStructured, structuredParams } from '../llm/client.js';
import { DEDUPE_SYSTEM, MATCH_SCHEMA } from '../llm/prompts.js';

const VALID = new Set(['action', 'followup', 'waiting', 'decision', 'idea', 'question']);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function priorItemsForPage(pageId) {
  return db.prepare(`SELECT i.id, i.text, i.status FROM items i JOIN item_mentions m ON m.item_id = i.id WHERE m.page_id = ?`).all(pageId);
}

function mention(itemId, pageId, pageDate) {
  // Upsert: a re-transcription can move the page to another date (e.g. a date written in later).
  db.prepare(`INSERT INTO item_mentions (item_id, page_id, page_date) VALUES (?,?,?)
    ON CONFLICT(item_id, page_id) DO UPDATE SET page_date=excluded.page_date`).run(itemId, pageId, pageDate);
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
  const id = newId('it'), code = nextCode();
  const { due, due_time } = dueOf(it, pageDate);
  db.prepare(`INSERT INTO items (id, code, text, kind, person, assignee, due, due_time, priority, tags, status,
    first_page_id, last_page_id, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, code, it.text.trim(), VALID.has(it.kind) ? it.kind : 'action', it.person || null, it.assignee || null,
    due, due_time, it.priority ? 1 : 0, J(it.tags), 'open', pageId, pageId, pageDate, pageDate);
  recordEvent('handwriting', code, 'created', null, it.text.trim());
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
  changeItem(id, 'handwriting', () => db.prepare(`UPDATE items SET text=@text, person=@person, assignee=@assignee,
    due=@due, due_time=@due_time, priority=@priority, tags=@tags WHERE id=@id`).run({
    id,
    text: hand.has('text') ? cur.text : it.text.trim(),
    person: name('person'),
    assignee: name('assignee'),
    due: keepDue ? cur.due : read.due,
    due_time: keepDue ? cur.due_time : read.due_time,
    priority: Math.max(cur.priority, it.priority ? 1 : 0),
    tags: J(it.tags),
  }));
  if ((it.status === 'done' || it.status === 'dropped') && cur.status !== it.status) setItemStatus(id, it.status, 'handwriting', 'checked on page');
}

async function matchAgainstOpen(candidates, excludeIds) {
  const open = openItems().filter((o) => !excludeIds.has(o.id));
  if (!candidates.length || !open.length) return new Map();
  const content = `${candidates.map((c, i) => `NEW n${i}: ${c.text}${c.person ? ` [${c.person}]` : ''}`).join('\n')}\n\n${open.map((o) => `OPEN ${o.code}: ${o.text}${o.person ? ` [${o.person}]` : ''}`).join('\n')}`;
  const res = await callStructured(structuredParams({ model: config.llm.triageModel, systemBlocks: [DEDUPE_SYSTEM], content, schema: MATCH_SCHEMA }), 'dedupe');
  const byCode = new Map(open.map((o) => [o.code, o.id]));
  const out = new Map();
  for (const m of res.matches || []) {
    const idx = Number(String(m.new_ref).replace(/^n/, ''));
    if (byCode.has(m.code) && candidates[idx]) out.set(idx, byCode.get(m.code));
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
  const prevDate = db.prepare('SELECT page_date FROM pages WHERE id=?').get(pageRow.id)?.page_date || null;
  db.prepare(`UPDATE pages SET status='transcribed', transcribed_hash=rm_hash, page_date=?, summary=?, tags=?, transcription_md=?,
    legibility=?, uncertain=?, batch_id=NULL, error=NULL, updated_at=datetime('now') WHERE id=?`)
    .run(pageDate, result.summary || '', J(canonicalTags(result.tags, r)), result.transcription_md || '', result.legibility || null, J(result.uncertain_spans), pageRow.id);

  const prior = priorItemsForPage(pageRow.id);
  const priorIds = new Set(prior.map((p) => p.id));
  const touched = new Set();
  const fresh = [];

  for (const raw of result.items || []) {
    if (!raw?.text?.trim()) continue;
    const it = normalize(raw, r);
    if (it.existing_item_id && priorIds.has(it.existing_item_id)) {
      refreshItem(it.existing_item_id, it, pageDate, r);
      mention(it.existing_item_id, pageRow.id, pageDate);
      touched.add(it.existing_item_id);
    } else fresh.push(it);
  }

  // Carry-forward detection for new items. This runs before the erase pass on purpose: this page's own earlier
  // items are still open here, so one the model re-extracted without existing_item_id (or reworded) matches
  // and keeps its number instead of being dropped as "erased" and re-created under a new one.
  const matches = await matchAgainstOpen(fresh, touched);
  let created = 0, carried = 0;
  fresh.forEach((it, idx) => {
    const existing = matches.get(idx);
    if (existing) {
      refreshItem(existing, it, pageDate, r); mention(existing, pageRow.id, pageDate); touched.add(existing);
      if (!priorIds.has(existing)) carried++;
    } else { touched.add(insertItem(it, pageRow.id, pageDate)); created++; }
  });

  // Items that came only from this page and vanished from it were erased on the tablet → dropped.
  for (const p of prior) {
    if (touched.has(p.id) || p.status !== 'open') continue;
    const others = db.prepare('SELECT COUNT(*) AS n FROM item_mentions WHERE item_id=? AND page_id<>?').get(p.id, pageRow.id).n;
    if (!others) { setItemStatus(p.id, 'dropped', 'erased', 'no longer on source page'); touched.add(p.id); }
  }

  // Number-based closes / snoozes.
  let closed = 0;
  for (const c of result.closes || []) {
    const item = db.prepare('SELECT id, status FROM items WHERE code=?').get(c.code);
    if (!item || item.status === 'done' || item.status === 'dropped') continue;
    if (c.action === 'snooze' && isDate(c.snooze_until)) setItemStatus(item.id, 'snoozed', 'handwriting', c.evidence, c.snooze_until);
    else if (c.action === 'done' || c.action === 'dropped') { setItemStatus(item.id, c.action, 'handwriting', c.evidence); closed++; }
    else continue;
    touched.add(item.id);
  }

  return { pageDate, prevDate, created, carried, closed, itemIds: [...touched] };
}

export const itemTags = (i) => P(i.tags);
