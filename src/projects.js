// Project rollups (spec §1.5): SQL and the registry, no LLM. A project is a registry entry. A page belongs to it when
// one of its stored tags is the project's tag or an alias (checked against the current registry, so tags stored before
// an alias was added count too). An item belongs to the projects its own tags name; an item with no project tag of its
// own (the transcriber tags lines one by one, and often leaves them bare under a #tag heading) belongs to the
// projects of the pages it's written on. Every list goes through the caller's visibility(), and at sensitivity normal
// a restricted project isn't there at all.
import { db, P, openItems } from './db.js';
import { localDate } from './config.js';
import { currentRegistry, canonicalTag, canonicalTags, unregisteredTags, tagKey } from './registry.js';
import { isDelegated } from './output/markdown.js';
import { addDays } from './digest/digest.js';

const DECISION_DAYS = 90;
const closedOn = (i) => (i.closed_at ? localDate(new Date(i.closed_at)) : null);
const registryEntry = ({ tag, name, aliases, program, status, sensitivity, notebook, funding, people, search }) =>
  ({ tag, name, aliases, program, status, sensitivity, notebook, funding, people, search });

/** The visible items and transcribed pages, each with the keys of the projects it belongs to. */
function rows(vis, r) {
  const projectKeys = (tags) => canonicalTags(P(tags), r).map(tagKey).filter((k) => r.keys.has(k));
  const onPages = new Map(); // item id → project keys of the pages its line is on
  for (const m of db.prepare(`SELECT m.item_id, p.tags FROM item_mentions m JOIN pages p ON p.id = m.page_id WHERE m.gone_at IS NULL`).all()) {
    onPages.set(m.item_id, [...(onPages.get(m.item_id) ?? []), ...projectKeys(m.tags)]);
  }
  const keyed = (row) => ({ row, keys: new Set(projectKeys(row.tags)) });
  const keyedItem = (i) => {
    const own = projectKeys(i.tags);
    return { row: i, keys: new Set(own.length ? own : onPages.get(i.id) ?? []) };
  };
  return {
    items: db.prepare('SELECT * FROM items').all().filter(vis.item).map(keyedItem),
    open: openItems().filter(vis.item).map(keyedItem),
    pages: db.prepare(`SELECT p.id, p.tags, p.page_date, p.page_index, p.summary, d.name AS notebook FROM pages p
      JOIN documents d ON d.id = p.doc_id WHERE p.status = 'transcribed'`).all().filter(vis.page).map(keyed),
  };
}

/** open, waiting, overdue, carried_max (the most days an open item has been written on) and last_activity (a date). */
function counts(k, all, today) {
  const open = all.open.filter((x) => x.keys.has(k)).map((x) => x.row);
  const dates = [
    ...all.items.filter((x) => x.keys.has(k)).flatMap(({ row: i }) => [i.last_seen, i.first_seen, closedOn(i)]),
    ...all.pages.filter((x) => x.keys.has(k)).map((x) => x.row.page_date),
  ].filter(Boolean);
  return {
    open: open.length,
    waiting: open.filter(isDelegated).length,
    overdue: open.filter((i) => i.due && i.due < today).length,
    carried_max: open.length ? Math.max(...open.map((i) => i.carry_days || 1)) : null,
    last_activity: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
  };
}

/**
 * GET /api/projects: the registry's projects with their counts, and the tags written on visible items and pages that
 * the registry doesn't cover ({tag, items, pages, count}), most used first. Without a registry, no projects.
 */
export function projectList(vis, r = currentRegistry()) {
  if (!r) return { registry: null, programs: {}, projects: [], unregistered: [] };
  const today = localDate();
  const all = rows(vis, r);
  const projects = r.projects.filter((p) => vis.all || !vis.restrictedTags([p.tag]))
    .map((p) => ({ ...registryEntry(p), ...counts(tagKey(p.tag), all, today) }));
  const unregistered = new Map();
  for (const [unit, list] of [['items', all.items], ['pages', all.pages]]) {
    for (const { row } of list) {
      for (const t of unregisteredTags(P(row.tags), r)) {
        const c = unregistered.get(tagKey(t)) ?? { tag: t, items: 0, pages: 0 };
        c[unit]++;
        unregistered.set(tagKey(t), c);
      }
    }
  }
  return {
    registry: r.version,
    programs: Object.fromEntries(Object.entries(r.programs).map(([k, v]) => [k, { name: v.name ?? null, description: v.description ?? null }])),
    projects,
    unregistered: [...unregistered.values()].map((u) => ({ ...u, count: u.items + u.pages }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
  };
}

/**
 * GET /api/projects/:tag?days=30, the tag or one of its aliases. null when it isn't a registry project, or is a
 * restricted one and the client may not see restricted work. Items are rows from the items table.
 * - open: the open items (snoozes that have run out included), by kind;
 * - waiting: the open items waiting on someone else (kind waiting, the ← notation, or assigned to someone);
 * - decisions: decision items written in the last 90 days, whatever their status, newest first;
 * - questions: the open questions;
 * - pages: the summaries (never the text) of pages tagged with it in the window, newest first;
 * - closed: the items done or dropped in the window, latest first.
 * The window is the last `days` days, today included.
 */
export function projectDetail(raw, { days = 30 } = {}, vis, r = currentRegistry()) {
  const c = r && canonicalTag(raw, r);
  if (!c?.registered || c.context) return null;
  const p = r.byTag.get(c.tag);
  if (!p || (!vis.all && vis.restrictedTags([p.tag]))) return null;
  const today = localDate();
  const since = addDays(today, -(days - 1));
  const k = tagKey(p.tag);
  const all = rows(vis, r);
  const mine = (list) => list.filter((x) => x.keys.has(k)).map((x) => x.row);
  const open = mine(all.open);
  const items = mine(all.items);
  const byKind = {};
  for (const i of open) (byKind[i.kind] ??= []).push(i);
  const latest = (f) => (a, b) => String(f(b) ?? '').localeCompare(String(f(a) ?? '')) || b.code - a.code; // items
  return {
    project: registryEntry(p),
    days,
    since,
    ...counts(k, all, today),
    open: byKind,
    waiting: open.filter(isDelegated),
    decisions: items.filter((i) => i.kind === 'decision' && (i.first_seen ?? '') >= addDays(today, -(DECISION_DAYS - 1)))
      .sort(latest((i) => i.first_seen)),
    questions: open.filter((i) => i.kind === 'question'),
    pages: mine(all.pages).filter((pg) => pg.page_date && pg.page_date >= since)
      .sort((a, b) => b.page_date.localeCompare(a.page_date) || String(a.notebook ?? '').localeCompare(String(b.notebook ?? '')) || a.page_index - b.page_index)
      .map(({ page_date, notebook, page_index, summary }) => ({ page_date, notebook, page: page_index + 1, summary })),
    closed: items.filter((i) => ['done', 'dropped'].includes(i.status) && closedOn(i) >= since).sort(latest((i) => i.closed_at)),
  };
}
