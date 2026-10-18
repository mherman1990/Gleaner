// A database written by v0.1.2 (no due_time / assignee / edited columns) is upgraded in place when Gleaner starts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tempEnv } from './helpers.js';

const dataDir = tempEnv('migrate');
const old = new Database(path.join(dataDir, 'gleaner.db'));
old.exec(`CREATE TABLE items (
  id TEXT PRIMARY KEY, code INTEGER UNIQUE, text TEXT NOT NULL, kind TEXT NOT NULL,
  person TEXT, due TEXT, priority INTEGER DEFAULT 0, tags TEXT,
  status TEXT NOT NULL DEFAULT 'open', snooze_until TEXT, first_page_id TEXT, last_page_id TEXT,
  first_seen TEXT, last_seen TEXT, carry_days INTEGER DEFAULT 1,
  closed_at TEXT, closed_by TEXT, close_evidence TEXT, last_nudged TEXT, nudge_count INTEGER DEFAULT 0
);
INSERT INTO items (id, code, text, kind, due, status, closed_at, closed_by) VALUES ('it_1', 1, 'USB Report', 'action', '2026-10-20', 'done', '2026-10-18T14:00:00Z', 'api');`);
old.close();

const { db, editItem, setItemStatus } = await import('../src/db.js');

test('a v0.1.2 database gains the new columns and keeps its items', () => {
  const cols = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  for (const c of ['due_time', 'assignee', 'edited']) assert.ok(cols.includes(c), c);
  const row = db.prepare('SELECT * FROM items WHERE code=1').get();
  assert.deepEqual([row.text, row.due, row.status, row.due_time, row.assignee, row.edited], ['USB Report', '2026-10-20', 'done', null, null, null]);

  setItemStatus(row.id, 'open', 'cli');
  editItem(row.id, { due_time: '2pm', assignee: 'Jen' });
  const after = db.prepare('SELECT * FROM items WHERE code=1').get();
  assert.deepEqual([after.status, after.due_time, after.assignee, after.edited], ['open', '14:00', 'Jen', '["due_time","assignee"]']);
});

after(() => db.close());
