// The schema as of v0.1.4, from before migrations were numbered. Every statement is idempotent, so this runs
// safely on a fresh database, a v0.1.4 one (no change), or an older one (it adds the v0.1.3 item columns).
export const id = '001-baseline-v0.1.4';

export function up(db) {
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
  // v0.1.3 added these; CREATE TABLE IF NOT EXISTS leaves an older items table without them.
  const cols = new Set(db.prepare('PRAGMA table_info(items)').all().map((c) => c.name));
  for (const col of ['due_time', 'assignee', 'edited']) {
    if (!cols.has(col)) db.exec(`ALTER TABLE items ADD COLUMN ${col} TEXT`);
  }
}
