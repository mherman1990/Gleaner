// The ledger turns per-page extraction into durable open loops.
//  1. Same-page items are updated in place (existing_item_id) so re-transcribing an edited page never duplicates.
//  2. Number-based closes ("✓14") update earlier items.
//  3. Genuinely new items are checked against all open loops (Haiku) — a match means he rewrote/carried it,
//     which bumps carry_days instead of creating a duplicate. carry_days is the "you keep carrying this" signal.
import { db, newId, nextCode, J, P, setItemStatus, openItems } from '../db.js';
import { config } from '../config.js';
import { callTool, toolParams } from '../llm/client.js';
import { DEDUPE_SYSTEM, MATCH_TOOL } from '../llm/prompts.js';

const VALID = new Set(['action', 'followup', 'waiting', 'decision', 'idea', 'question']);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function priorItemsForPage(pageId) {
  return db.prepare(`SELECT i.id, i.text, i.status FROM items i JOIN item_mentions m ON m.item_id = i.id WHERE m.page_id = ?`).all(pageId);
}

function mention(itemId, pageId, pageDate) {
  db.prepare('INSERT OR IGNORE INTO item_mentions (item_id, page_id, page_date) VALUES (?,?,?)').run(itemId, pageId, pageDate);
  const days = db.prepare('SELECT COUNT(DISTINCT page_date) AS n FROM item_mentions WHERE item_id=?').get(itemId).n;
  db.prepare(`UPDATE items SET carry_days=?, last_page_id=?, last_seen=MAX(COALESCE(last_seen,''), ?) WHERE id=?`)
    .run(Math.max(1, days), pageId, pageDate, itemId);
}

function insertItem(it, pageId, pageDate) {
  const id = newId('it');
  db.prepare(`INSERT INTO items (id, code, text, kind, person, due, priority, tags, status, first_page_id, last_page_id, first_seen, last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, nextCode(), it.text.trim(), VALID.has(it.kind) ? it.kind : 'action', it.person || null,
    isDate(it.due) ? it.due : null, it.priority ? 1 : 0, J(it.tags), 'open', pageId, pageId, pageDate, pageDate);
  if (it.status === 'done' || it.status === 'dropped') setItemStatus(id, it.status, 'handwriting', 'marked on source page');
  mention(id, pageId, pageDate);
  return id;
}

function refreshItem(id, it) {
  db.prepare(`UPDATE items SET text=?, person=COALESCE(?, person), due=COALESCE(?, due),
    priority=MAX(priority, ?), tags=? WHERE id=?`)
    .run(it.text.trim(), it.person || null, isDate(it.due) ? it.due : null, it.priority ? 1 : 0, J(it.tags), id);
  const cur = db.prepare('SELECT status FROM items WHERE id=?').get(id);
  if ((it.status === 'done' || it.status === 'dropped') && cur.status !== it.status) setItemStatus(id, it.status, 'handwriting', 'checked on page');
}

async function matchAgainstOpen(candidates, excludeIds) {
  const open = openItems().filter((o) => !excludeIds.has(o.id));
  if (!candidates.length || !open.length) return new Map();
  const content = `${candidates.map((c, i) => `NEW n${i}: ${c.text}${c.person ? ` [${c.person}]` : ''}`).join('\n')}\n\n${open.map((o) => `OPEN ${o.code}: ${o.text}${o.person ? ` [${o.person}]` : ''}`).join('\n')}`;
  const res = await callTool(toolParams({ model: config.llm.triageModel, systemBlocks: [DEDUPE_SYSTEM], content, tool: MATCH_TOOL, maxTokens: 1024 }), 'dedupe');
  const byCode = new Map(open.map((o) => [o.code, o.id]));
  const out = new Map();
  for (const m of res.matches || []) {
    const idx = Number(String(m.new_ref).replace(/^n/, ''));
    if (byCode.has(m.code) && candidates[idx]) out.set(idx, byCode.get(m.code));
  }
  return out;
}

/** Apply one record_page result. Returns a short summary for logging. */
export async function applyPageResult(pageRow, result, fallbackDate) {
  const pageDate = isDate(result.page_date) ? result.page_date : fallbackDate;
  db.prepare(`UPDATE pages SET status='transcribed', transcribed_hash=rm_hash, page_date=?, summary=?, tags=?, transcription_md=?,
    legibility=?, uncertain=?, batch_id=NULL, error=NULL, updated_at=datetime('now') WHERE id=?`)
    .run(pageDate, result.summary || '', J(result.tags), result.transcription_md || '', result.legibility || null, J(result.uncertain_spans), pageRow.id);

  const prior = priorItemsForPage(pageRow.id);
  const priorIds = new Set(prior.map((p) => p.id));
  const touched = new Set();
  const fresh = [];

  for (const it of result.items || []) {
    if (!it?.text?.trim()) continue;
    if (it.existing_item_id && priorIds.has(it.existing_item_id)) {
      refreshItem(it.existing_item_id, it);
      mention(it.existing_item_id, pageRow.id, pageDate);
      touched.add(it.existing_item_id);
    } else fresh.push(it);
  }

  // Items that came only from this page and vanished from it were erased on the tablet → dropped.
  for (const p of prior) {
    if (touched.has(p.id) || p.status !== 'open') continue;
    const others = db.prepare('SELECT COUNT(*) AS n FROM item_mentions WHERE item_id=? AND page_id<>?').get(p.id, pageRow.id).n;
    if (!others) setItemStatus(p.id, 'dropped', 'erased', 'no longer on source page');
  }

  // Carry-forward detection for new items.
  const matches = await matchAgainstOpen(fresh, touched);
  let created = 0, carried = 0;
  fresh.forEach((it, idx) => {
    const existing = matches.get(idx);
    if (existing) { refreshItem(existing, it); mention(existing, pageRow.id, pageDate); carried++; }
    else { insertItem(it, pageRow.id, pageDate); created++; }
  });

  // Number-based closes / snoozes.
  let closed = 0;
  for (const c of result.closes || []) {
    const item = db.prepare('SELECT id, status FROM items WHERE code=?').get(c.code);
    if (!item || item.status === 'done' || item.status === 'dropped') continue;
    if (c.action === 'snooze' && isDate(c.snooze_until)) setItemStatus(item.id, 'snoozed', 'handwriting', c.evidence, c.snooze_until);
    else if (c.action === 'done' || c.action === 'dropped') { setItemStatus(item.id, c.action, 'handwriting', c.evidence); closed++; }
  }

  return { pageDate, created, carried, closed };
}

export const itemTags = (i) => P(i.tags);
