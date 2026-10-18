// Markdown is the durable, greppable system of record. Files are regenerated from SQLite (idempotent),
// so editing them by hand is pointless — edit on the tablet or via the API instead.
import fs from 'node:fs';
import path from 'node:path';
import { paths, localDate, fmtTime } from '../config.js';
import { db, P, openItems } from '../db.js';

const KIND_ICON = { action: '☐', followup: '→', waiting: '←', decision: 'DEC', idea: 'idea', question: '?' };

/** Someone else has it: a "waiting on" item, or one assigned to another person. */
export const isDelegated = (i) => i.kind === 'waiting' || !!i.assignee;

export function itemLine(i) {
  const bits = [`**#${i.code}**`, KIND_ICON[i.kind] || '', i.text];
  if (i.person) bits.push(`— ${i.person}`);
  if (i.assignee) bits.push(`@${i.assignee}`);
  if (i.due) bits.push(`(due ${i.due}${i.due_time ? ` ${fmtTime(i.due_time)}` : ''})`);
  if (i.priority) bits.push('!');
  if (i.carry_days > 1) bits.push(`[carried ${i.carry_days}d]`);
  if (i.status !== 'open') bits.push(`*${i.status}*`);
  return `- ${bits.filter(Boolean).join(' ')}`;
}

export function dayFilePath(date) {
  return path.join(paths.notes, date.slice(0, 4), `${date}.md`);
}

export function renderDay(date) {
  const pages = db.prepare(`SELECT p.*, d.name AS doc_name FROM pages p JOIN documents d ON d.id = p.doc_id
    WHERE p.page_date = ? AND p.status = 'transcribed' ORDER BY d.name, p.page_index`).all(date);
  if (!pages.length) return null;
  const tags = [...new Set(pages.flatMap((p) => P(p.tags)))].sort();
  const items = db.prepare(`SELECT DISTINCT i.* FROM items i JOIN item_mentions m ON m.item_id=i.id WHERE m.page_date=? ORDER BY i.code`).all(date);

  const fm = ['---', `date: ${date}`, `tags: [${tags.join(', ')}]`, `pages: ${pages.length}`,
    `notebooks: [${[...new Set(pages.map((p) => JSON.stringify(p.doc_name)))].join(', ')}]`, `generated_by: gleaner`, '---'];
  const body = pages.map((p) => {
    const unc = P(p.uncertain);
    return [`## ${p.doc_name} — p${p.page_index + 1}`, `> ${p.summary}${p.legibility && p.legibility !== 'high' ? ` _(legibility: ${p.legibility})_` : ''}`, '',
      p.transcription_md.trim(), unc.length ? `\n_Uncertain: ${unc.join('; ')}_` : ''].join('\n');
  });
  const itemsBlock = items.length ? ['## Items from this day', ...items.map(itemLine)].join('\n') : '';
  return [...fm, '', `# ${date}`, '', itemsBlock, '', ...body.flatMap((b) => [b, ''])].join('\n');
}

export function writeDayFiles(dates) {
  for (const d of new Set(dates.filter(Boolean))) {
    const md = renderDay(d);
    const f = dayFilePath(d);
    if (!md) { fs.rmSync(f, { force: true }); continue; } // its last page moved to another date
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, md);
  }
}

/** Page-dates on which these items were written — the day files whose item lines show their status. */
export function mentionDates(itemIds) {
  if (!itemIds.length) return [];
  const q = db.prepare('SELECT DISTINCT page_date FROM item_mentions WHERE item_id=?');
  return [...new Set(itemIds.flatMap((id) => q.all(id).map((r) => r.page_date)))];
}

/** After an item changes outside ingest (API, CLI): rewrite its day files and the open-loop list. */
export function refreshItemOutputs(itemIds) {
  writeDayFiles(mentionDates(itemIds));
  writeOpenLoops();
}

export function renderOpenLoops() {
  const today = localDate();
  const items = openItems();
  const groups = {
    'Overdue': items.filter((i) => i.due && i.due < today),
    'Due today': items.filter((i) => i.due === today),
    'Priority': items.filter((i) => i.priority && !(i.due && i.due <= today)),
    'Waiting on others': items.filter((i) => isDelegated(i) && !i.priority && !(i.due && i.due <= today)),
    'Everything else': items.filter((i) => !i.priority && !isDelegated(i) && !(i.due && i.due <= today)),
  };
  const out = [`# Open loops — ${today}`, '', `${items.length} open.`, ''];
  for (const [h, list] of Object.entries(groups)) if (list.length) out.push(`## ${h}`, ...list.map(itemLine), '');
  return out.join('\n');
}

export function writeOpenLoops() {
  fs.writeFileSync(path.join(paths.notes, 'open-loops.md'), renderOpenLoops());
}
