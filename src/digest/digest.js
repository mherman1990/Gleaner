import fs from 'node:fs';
import path from 'node:path';
import { config, paths, localDate, localWeekday, localTime, fmtTime } from '../config.js';
import { db, now, openItems, startRun, endRun, P } from '../db.js';
import { callStructured, callText, structuredParams } from '../llm/client.js';
import { DAILY_SYSTEM, DAILY_SCHEMA, WEEKLY_SYSTEM } from '../llm/prompts.js';
import { itemLine, isDelegated } from '../output/markdown.js';
import { buildTodaySheet } from './todaySheet.js';
import { notify, pushToTablet } from '../notify/index.js';

export const addDays = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

export function buckets(today = localDate()) {
  const items = openItems();
  const staleCut = addDays(today, -config.reminders.staleDays);
  return {
    items,
    overdue: items.filter((i) => i.due && i.due < today),
    dueToday: items.filter((i) => i.due === today),
    waiting: items.filter(isDelegated),
    carrying: items.filter((i) => i.carry_days >= config.reminders.carryFlagAt).sort((a, b) => b.carry_days - a.carry_days),
    stale: items.filter((i) => (i.last_seen || i.first_seen) < staleCut),
  };
}

const ledgerLine = (i) =>
  `#${i.code} ${i.kind}: ${i.text}${i.person ? ` [${i.person}]` : ''}${i.assignee ? ` assigned=${i.assignee}` : ''}` +
  `${i.due ? ` due=${i.due}${i.due_time ? ` ${i.due_time}` : ''}` : ''}${i.priority ? ' PRIORITY' : ''}` +
  ` carried=${i.carry_days}d first=${i.first_seen} last=${i.last_seen}${P(i.tags).length ? ` tags=${P(i.tags).join(',')}` : ''}`;

export async function morningDigest({ push = true } = {}) {
  const runId = startRun('digest');
  try {
    const today = localDate();
    const b = buckets(today);
    const recent = db.prepare(`SELECT p.page_date, d.name, p.summary FROM pages p JOIN documents d ON d.id=p.doc_id
      WHERE p.status='transcribed' AND p.page_date >= ? ORDER BY p.page_date DESC LIMIT 20`).all(addDays(today, -3));

    let plan = { headline: 'No open loops in the ledger.', top3: [], carrying_callout: null, drop_candidates: [] };
    if (b.items.length) {
      const content = `Today is ${localWeekday()} ${today}.\n\nOPEN LEDGER (${b.items.length}):\n${b.items.map(ledgerLine).join('\n')}\n\n` +
        `RECENT PAGES:\n${recent.map((r) => `${r.page_date} ${r.name}: ${r.summary}`).join('\n') || 'none'}`;
      plan = await callStructured(structuredParams({ model: config.llm.digestModel, systemBlocks: [DAILY_SYSTEM], content, schema: DAILY_SCHEMA }), 'digest');
    }
    const byCode = new Map(b.items.map((i) => [i.code, i]));
    const top = (plan.top3 || []).filter((t) => byCode.has(t.code)).slice(0, 3).map((t) => ({ ...byCode.get(t.code), why: t.why }));

    const sec = (title, list, extra) => (list.length ? [`## ${title}`, extra ? `_${extra}_` : null, ...list].filter(Boolean).join('\n') : null);
    const md = [
      `# Today — ${localWeekday()}, ${today}`,
      `**${plan.headline}**`,
      sec('Top 3', top.map((i) => `${itemLine(i)}\n  - _${i.why}_`)),
      sec('Overdue', b.overdue.map(itemLine)),
      sec('Due today', b.dueToday.map(itemLine)),
      sec('Waiting on others', b.waiting.map(itemLine)),
      sec('Carrying', b.carrying.map(itemLine), plan.carrying_callout),
      plan.drop_candidates?.length ? `**Consider dropping:** ${plan.drop_candidates.map((c) => `#${c}`).join(', ')}` : null,
      `_${b.items.length} open loops total. Close on the tablet: ✓14 · drop: x14 · snooze: 14 → Fri_`,
    ].filter(Boolean).join('\n\n');

    const json = { date: today, generated_at: now(), plan, top, ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.map((i) => i.code)])) };
    fs.writeFileSync(path.join(paths.out, `digest-${today}.md`), md);
    fs.writeFileSync(path.join(paths.out, `digest-${today}.json`), JSON.stringify(json, null, 2));
    fs.writeFileSync(path.join(paths.out, 'digest-latest.md'), md);

    const result = { date: today, open: b.items.length, top: top.map((t) => t.code), pushed: {} };
    if (push) {
      const pdf = await buildTodaySheet({ today, plan, top, b });
      if (config.notify.tabletTodaySheet) result.pushed.tablet = await pushToTablet(pdf).catch((e) => `error: ${e.message}`);
      result.pushed.notify = await notify({
        title: `Today: ${top.length ? top.map((t) => `#${t.code}`).join(' · ') : 'no top items'}`,
        body: [plan.headline, ...top.map((t) => `#${t.code} ${t.text}`), b.overdue.length ? `${b.overdue.length} overdue` : ''].filter(Boolean).join('\n'),
        priority: b.overdue.length ? 'high' : 'default',
      });
    }
    endRun(runId, true, result);
    return { ...result, md };
  } catch (e) { endRun(runId, false, e.stack || e.message); throw e; }
}

/**
 * Every 30 min in working hours: nudge due-today and overdue items, at most once per item per day. An item due
 * today at a set time waits until the first sweep within reminders.leadMinutes of it. A nudge only counts once
 * a channel (Teams, ntfy) accepted it, so with none set up, or one failing, nothing is used up.
 */
export async function reminderSweep({ at = new Date() } = {}) {
  const today = localDate(at);
  const lead = new Date(at.getTime() + config.reminders.leadMinutes * 60000);
  const soon = localDate(lead) > today ? '24:00' : localTime(lead);
  const b = buckets(today);
  // last_nudged is a UTC timestamp; compare its local date (a 6:30pm CST nudge is already "tomorrow" in UTC).
  const due = [...b.overdue, ...b.dueToday].filter((i) =>
    (i.due < today || !i.due_time || i.due_time <= soon) &&
    (!i.last_nudged || localDate(new Date(i.last_nudged)) < today) && i.nudge_count < config.reminders.maxNudgesPerItem);
  if (!due.length) return { nudged: 0 };
  const sent = await notify({
    title: `${due.length} due${b.overdue.length ? ` (${b.overdue.length} overdue)` : ''}`,
    body: due.map((i) => `#${i.code} ${i.text}${i.assignee ? ` (@${i.assignee})` : ''}` +
      `${i.due < today ? ` — was due ${i.due}` : i.due_time ? ` — at ${fmtTime(i.due_time)}` : ''}`).join('\n'),
    priority: due.some((i) => i.due < today) ? 'high' : 'default',
  });
  if (!Object.values(sent).includes('ok')) return { nudged: 0, due: due.length, sent };
  const upd = db.prepare(`UPDATE items SET last_nudged=?, nudge_count=nudge_count+1 WHERE id=?`);
  due.forEach((i) => upd.run(at.toISOString(), i.id));
  return { nudged: due.length, sent };
}

export async function weeklyReview({ push = true } = {}) {
  const today = localDate();
  const since = addDays(today, -7);
  const b = buckets(today);
  const closed = db.prepare(`SELECT * FROM items WHERE closed_at >= ? ORDER BY closed_at`).all(`${since}T00:00:00`);
  const opened = db.prepare(`SELECT * FROM items WHERE first_seen >= ?`).all(since);
  const pages = db.prepare(`SELECT p.page_date, d.name, p.summary FROM pages p JOIN documents d ON d.id=p.doc_id
    WHERE p.status='transcribed' AND p.page_date >= ? ORDER BY p.page_date`).all(since);
  const content = `Week ending ${today}.\n\nPAGES:\n${pages.map((p) => `${p.page_date} ${p.name}: ${p.summary}`).join('\n') || 'none'}` +
    `\n\nOPENED THIS WEEK:\n${opened.map(ledgerLine).join('\n') || 'none'}` +
    `\n\nCLOSED THIS WEEK:\n${closed.map((i) => `#${i.code} ${i.status} via ${i.closed_by}: ${i.text}`).join('\n') || 'none'}` +
    `\n\nSTILL OPEN:\n${b.items.map(ledgerLine).join('\n') || 'none'}` +
    `\n\nSTALE (no mention in ${config.reminders.staleDays}+ days): ${b.stale.map((i) => `#${i.code}`).join(', ') || 'none'}`;
  const md = `# Weekly review — week ending ${today}\n\n` + await callText({ model: config.llm.weeklyModel, system: WEEKLY_SYSTEM, content }, 'weekly');
  fs.writeFileSync(path.join(paths.out, `weekly-${today}.md`), md);
  if (push) await notify({ title: `Weekly review ready (${closed.length} closed, ${b.items.length} open)`, body: md.slice(0, 1500), priority: 'default' });
  return { date: today, closed: closed.length, open: b.items.length, md };
}
