-- Gleaner database as of v0.1.4 (schema from src/db.js at v0.1.4/v0.1.5), with invented rows.
-- Used by test/migrate.test.js to check that migrations upgrade an existing database in place.

CREATE TABLE documents (
  id TEXT PRIMARY KEY, name TEXT, folder TEXT, modified TEXT, version TEXT, last_pulled TEXT
);
INSERT INTO documents (id, name, folder, modified, version, last_pulled) VALUES ('doc-todo', 'To do', '/Daily', '2026-10-16T13:00:00.000Z', '0:2026-10-16T13:00:00.000Z', '2026-10-16T13:05:00.000Z');
CREATE TABLE pages (
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
INSERT INTO pages (id, doc_id, page_index, rm_hash, transcribed_hash, status, png_path, typed_text, page_date, summary, tags, transcription_md, legibility, uncertain, batch_id, error, updated_at) VALUES ('pg-1', 'doc-todo', 0, 'h1', 'h1', 'transcribed', '/data/renders/pg-1.png', '', '2026-10-16', 'Invented to-do list for a fixture', '["45Z","widget-permits"]', '- ☐ Draft the fixture memo\n- ☐ Call the fixture vendor', 'high', '[]', NULL, NULL, '2026-10-16 13:06:00');
CREATE TABLE items (
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
INSERT INTO items (id, code, text, kind, person, due, priority, tags, due_time, assignee, edited, status, snooze_until, first_page_id, last_page_id, first_seen, last_seen, carry_days, closed_at, closed_by, close_evidence, last_nudged, nudge_count) VALUES ('it_a', 1, 'Draft the fixture memo', 'action', NULL, '2026-10-20', 1, '["45Z"]', '14:00', 'Pat', '["due_time","assignee"]', 'open', NULL, 'pg-1', 'pg-1', '2026-10-16', '2026-10-16', 1, NULL, NULL, NULL, NULL, 0);
INSERT INTO items (id, code, text, kind, person, due, priority, tags, due_time, assignee, edited, status, snooze_until, first_page_id, last_page_id, first_seen, last_seen, carry_days, closed_at, closed_by, close_evidence, last_nudged, nudge_count) VALUES ('it_b', 2, 'Call the fixture vendor', 'followup', 'Sam', NULL, 0, '["widget-permits"]', NULL, NULL, NULL, 'done', NULL, 'pg-1', 'pg-1', '2026-10-16', '2026-10-16', 1, '2026-10-17T15:00:00.000Z', 'api', NULL, NULL, 0);
CREATE TABLE item_mentions (
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE, page_id TEXT, page_date TEXT,
  PRIMARY KEY (item_id, page_id)
);
INSERT INTO item_mentions (item_id, page_id, page_date) VALUES ('it_a', 'pg-1', '2026-10-16');
INSERT INTO item_mentions (item_id, page_id, page_date) VALUES ('it_b', 'pg-1', '2026-10-16');
CREATE TABLE batches (
  id TEXT PRIMARY KEY, kind TEXT, status TEXT, created_at TEXT, ended_at TEXT
);
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, started_at TEXT, ended_at TEXT, ok INTEGER, detail TEXT
);
INSERT INTO runs (id, kind, started_at, ended_at, ok, detail) VALUES (1, 'ingest:sync', '2026-10-16T13:05:00.000Z', '2026-10-16T13:06:00.000Z', 1, '{"docs":1,"pages":1,"created":2}');
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, model TEXT, purpose TEXT, batch INTEGER,
  input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER
);
INSERT INTO usage (id, at, model, purpose, batch, input_tokens, output_tokens, cache_read, cache_write) VALUES (1, '2026-10-16T13:06:00.000Z', 'claude-sonnet-5-5', 'transcribe', 0, 4000, 1200, 0, 1500);
CREATE INDEX idx_items_status ON items(status);
CREATE INDEX idx_pages_status ON pages(status);
