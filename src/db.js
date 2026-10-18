import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { paths, localDate, normTime } from './config.js';

export const db = new Database(paths.db);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, name TEXT, folder TEXT, modified TEXT, version TEXT, last_pulled TEXT
);
CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,                 -- tablet page uuid
  doc_id TEXT REFERENCES documents(id),
  page_index INTEGER,
  rm_hash TEXT,                        -- sha256 of the .rm bytes (change detection)
  transcribed_hash TEXT,               -- rm_hash the current transcription reflects
  status TEXT DEFAULT 'new',           -- new | rendered | queued | transcribed | blank | error
  png_path TEXT, typed_text TEXT,
  page_date TEXT, summary TEXT, tags TEXT, transcription_md TEXT, legibility TEXT, uncertain TEXT,
  batch_id TEXT, error TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  code INTEGER UNIQUE,                 -- short number printed on the Today sheet; write "✓14" to close
  text TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- action | followup | waiting | decision | idea | question
  person TEXT, due TEXT, priority INTEGER DEFAULT 0, tags TEXT,
  due_time TEXT,                       -- HH:MM local, only with due
  assignee TEXT,                       -- who it's assigned to; null = Matt
  edited TEXT,                         -- JSON list of fields set by hand, which re-transcription leaves alone
  status TEXT NOT NULL DEFAULT 'open', -- open | done | dropped | snoozed
  snooze_until TEXT,
  first_page_id TEXT, last_page_id TEXT,
  first_seen TEXT, last_seen TEXT,     -- page dates
  carry_days INTEGER DEFAULT 1,        -- distinct page-dates it has been written on
  closed_at TEXT, closed_by TEXT, close_evidence TEXT,
  last_nudged TEXT, nudge_count INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS item_mentions (
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE, page_id TEXT, page_date TEXT,
  PRIMARY KEY (item_id, page_id)
);
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY, kind TEXT, status TEXT, created_at TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, started_at TEXT, ended_at TEXT, ok INTEGER, detail TEXT
);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, model TEXT, purpose TEXT, batch INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_pages_status ON pages(status);
`);

// Columns added after v0.1.2. CREATE TABLE IF NOT EXISTS leaves an existing table alone, so add them to it here.
for (const [table, col] of [['items', 'due_time'], ['items', 'assignee'], ['items', 'edited']]) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
}

export const now = () => new Date().toISOString();
export const newId = (p = 'it') => `${p}_${crypto.randomBytes(5).toString('hex')}`;
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const J = (v) => JSON.stringify(v ?? []);
export const P = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

export function logUsage(model, purpose, usage, batch = false) {
  if (!usage) return;
  db.prepare(`INSERT INTO usage (at, model, purpose, batch, input_tokens, output_tokens, cache_read, cache_write)
    VALUES (?,?,?,?,?,?,?,?)`).run(now(), model, purpose, batch ? 1 : 0,
    usage.input_tokens || 0, usage.output_tokens || 0,
    usage.cache_read_input_tokens || 0, usage.cache_creation_input_tokens || 0);
}

export function startRun(kind) {
  return db.prepare('INSERT INTO runs (kind, started_at) VALUES (?,?)').run(kind, now()).lastInsertRowid;
}
export function endRun(id, ok, detail) {
  db.prepare('UPDATE runs SET ended_at=?, ok=?, detail=? WHERE id=?')
    .run(now(), ok ? 1 : 0, typeof detail === 'string' ? detail : JSON.stringify(detail), id);
}

/** Open loops, including snoozed items whose snooze has expired. Priority first, then soonest due. */
export function openItems() {
  return db.prepare(`SELECT * FROM items
    WHERE status='open' OR (status='snoozed' AND snooze_until <= ?)
    ORDER BY priority DESC, (due IS NULL), due, (due_time IS NULL), due_time, first_seen`).all(localDate());
}

/** open (as openItems) | snoozed (still hidden) | closed (done or dropped, latest first) | all. */
export function listItems(status = 'open') {
  if (status === 'open') return openItems();
  if (status === 'snoozed') return db.prepare(`SELECT * FROM items WHERE status='snoozed' AND snooze_until > ? ORDER BY snooze_until, code`).all(localDate());
  if (status === 'closed') return db.prepare(`SELECT * FROM items WHERE status IN ('done','dropped') ORDER BY closed_at DESC, code DESC LIMIT 100`).all();
  if (status === 'all') return db.prepare('SELECT * FROM items ORDER BY code DESC LIMIT 500').all();
  throw new Error('status must be open|snoozed|closed|all');
}

export function nextCode() {
  return (db.prepare('SELECT MAX(code) AS m FROM items').get().m || 0) + 1;
}

export function setItemStatus(id, status, by, evidence = null, snoozeUntil = null) {
  const closing = status === 'done' || status === 'dropped';
  return db.prepare(`UPDATE items SET status=?, snooze_until=?, closed_at=?, closed_by=?, close_evidence=? WHERE id=?`)
    .run(status, snoozeUntil, closing ? now() : null, closing ? by : null, closing ? evidence : null, id).changes;
}

export const EDITABLE = ['text', 'due', 'due_time', 'assignee'];
/** A real calendar date as YYYY-MM-DD (Date.parse alone accepts 2026-02-31). */
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s)) && new Date(`${s}T12:00:00Z`).toISOString().startsWith(s);
const blank = (v) => v === null || v === undefined || String(v).trim() === '';

/**
 * A hand edit from the UI, API, or CLI. changes holds any of: text; due (YYYY-MM-DD, or null to clear it and its
 * time); due_time ("14:00", "2pm", or null; with no due date it means today); assignee (a name, or null for Matt).
 * Each field that changes is recorded in items.edited, so re-transcribing the page never overwrites it. A new due
 * date or time resets the nudge count. Throws on invalid input. Returns the fields that changed.
 */
export function editItem(id, changes) {
  const cur = db.prepare('SELECT * FROM items WHERE id=?').get(id);
  if (!cur) throw new Error('no such item');
  const next = {};
  if ('text' in changes) {
    if (blank(changes.text)) throw new Error('text cannot be empty');
    next.text = String(changes.text).trim().slice(0, 300);
  }
  if ('due' in changes) {
    if (!blank(changes.due) && !isDate(changes.due)) throw new Error('due must be YYYY-MM-DD');
    next.due = blank(changes.due) ? null : changes.due;
    if (!next.due) next.due_time = null;
  }
  if ('due_time' in changes) {
    const t = normTime(changes.due_time);
    if (!blank(changes.due_time) && !t) throw new Error('due_time must be a time like 14:00 or 2pm');
    if (t && !('due' in next ? next.due : cur.due)) {
      if ('due' in next) throw new Error('a time needs a due date');
      next.due = localDate();
    }
    next.due_time = t;
  }
  if ('assignee' in changes) next.assignee = blank(changes.assignee) ? null : String(changes.assignee).trim().slice(0, 60);

  const changed = Object.keys(next).filter((k) => next[k] !== cur[k]);
  if (!changed.length) return [];
  const edited = [...new Set([...P(cur.edited), ...changed])];
  const reset = changed.includes('due') || changed.includes('due_time');
  db.prepare(`UPDATE items SET ${changed.map((k) => `${k}=@${k}`).join(', ')}, edited=@edited
    ${reset ? ', last_nudged=NULL, nudge_count=0' : ''} WHERE id=@id`).run({ ...next, edited: J(edited), id });
  return changed;
}
