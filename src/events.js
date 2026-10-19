// Reading the audit trail (spec §1.3). Writing it is changeItem() / recordEvent() in db.js.
import { db, isDate } from './db.js';
import { config } from './config.js';

// Gleaner's own attributions for what was written on the tablet; everything else is a person or a client acting.
const FROM_PAGES = ['handwriting', 'erased'];

/** The UTC instant of local midnight at the start of a YYYY-MM-DD date, in the configured timezone. */
export function localMidnight(date) {
  const guess = new Date(`${date}T00:00:00Z`);
  const wall = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(guess);
  return new Date(guess.getTime() - (new Date(`${wall.replace(' ', 'T')}Z`).getTime() - guess.getTime()));
}

/**
 * since: "today" (local midnight), a YYYY-MM-DD date (its local midnight), or an ISO time. Absent: 24 hours ago.
 * Anything before 1970 means "from the start", and anything past 9999 (in UTC) "nothing yet". Returns an ISO string,
 * or null when it can't be read (an impossible date included: 2026-02-30 is an error, not March 2nd).
 */
export function parseSince(since, at = new Date()) {
  if (since === undefined || since === '') return new Date(at.getTime() - 24 * 3600e3).toISOString();
  const s = String(since).trim();
  if (s === 'today') return localMidnight(new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(at)).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(s) || !isDate(s.slice(0, 10))) return null;
  if (s.slice(0, 10) < '1970-01-02') return new Date(0).toISOString();
  if (s.length === 10) return localMidnight(s).toISOString();
  if (Number.isNaN(Date.parse(s))) return null;
  const iso = new Date(s).toISOString();
  return iso.startsWith('+') ? '9999-12-31T23:59:59.999Z' : iso; // "+010000-…" sorts before every stored time
}

/**
 * Events since an ISO time and after an event id, oldest first, at most `limit`; optionally one client's. Returns
 * { events, more }: when more is true, ask again with after = the last event's id. `vis` (src/sensitivity.js) drops
 * events of items the client may not see; an item whose tags ever included a restricted project is one of them.
 */
export function listEvents({ since, client, after = 0, limit = 1000 }, vis) {
  let rows = db.prepare(`SELECT id, at, client, item_code, field, old, new FROM events WHERE at >= ? AND id > ?
    ${client ? 'AND client = ?' : ''} ORDER BY id`).all(...[since, after, client].filter((v) => v !== undefined && v !== null && v !== ''));
  if (!vis.all) rows = rows.filter((e) => e.item_code !== null && vis.code(e.item_code));
  return { events: rows.slice(0, limit), more: rows.length > limit };
}

const ACTION = { done: 'closed', dropped: 'dropped', snoozed: 'snoozed', open: 'reopened' };
const NAME = { ui: 'UI', cli: 'CLI', mcp: 'MCP', legacy: 'The legacy token' };
const displayName = (c) => NAME[c] ?? c.charAt(0).toUpperCase() + c.slice(1);

/**
 * The morning digest's line on what people and clients (not the tablet) changed since `since`, e.g.
 * "Mayer closed 3, dropped 1; UI edited 2 (see events)." Edits count items, not fields. null when nothing changed.
 */
export function changesSince(since) {
  const rows = db.prepare(`SELECT client, item_code, field, new FROM events WHERE at >= ? AND client NOT IN (${FROM_PAGES.map(() => '?').join(',')})
    ORDER BY id`).all(since, ...FROM_PAGES);
  if (!rows.length) return null;
  const by = new Map(); // client -> action -> Set of item codes
  for (const e of rows) {
    // A snooze to a new date is still a snooze, not an edit; the date cleared by a close or reopen is neither.
    const action = e.field === 'status' ? ACTION[e.new] : e.field === 'snooze_until' ? (e.new ? 'snoozed' : null)
      : e.field === 'created' ? 'created' : 'edited';
    if (!action) continue;
    const acts = by.get(e.client) ?? new Map();
    acts.set(action, (acts.get(action) ?? new Set()).add(e.item_code));
    by.set(e.client, acts);
  }
  const order = ['closed', 'dropped', 'snoozed', 'reopened', 'created', 'edited'];
  const parts = [...by].map(([c, acts]) =>
    `${displayName(c)} ${order.filter((a) => acts.has(a)).map((a) => `${a} ${acts.get(a).size}`).join(', ')}`);
  return parts.length ? `${parts.join('; ')} (see events).` : null;
}
