import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { paths, localDate } from './config.js';

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
    ORDER BY priority DESC, (due IS NULL), due, first_seen`).all(localDate());
}

export function nextCode() {
  return (db.prepare('SELECT MAX(code) AS m FROM items').get().m || 0) + 1;
}

export function setItemStatus(id, status, by, evidence = null, snoozeUntil = null) {
  const closing = status === 'done' || status === 'dropped';
  return db.prepare(`UPDATE items SET status=?, snooze_until=?, closed_at=?, closed_by=?, close_evidence=? WHERE id=?`)
    .run(status, snoozeUntil, closing ? now() : null, closing ? by : null, closing ? evidence : null, id).changes;
}
