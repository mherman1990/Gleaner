// Older databases are upgraded in place when Gleaner starts: one written by v0.1.2 (no due_time / assignee /
// edited columns), and a v0.1.4 one taking every numbered migration, also when two processes start together.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { tempEnv } from './helpers.js';
import { migrate, MIGRATIONS } from '../src/migrations/index.js';

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
  editItem(row.id, { due_time: '2pm', assignee: 'Jen' }, 'ui');
  const after = db.prepare('SELECT * FROM items WHERE code=1').get();
  assert.deepEqual([after.status, after.due_time, after.assignee, after.edited], ['open', '14:00', 'Jen', '["due_time","assignee"]']);
});

after(() => db.close());

// Every numbered migration, run against a copy of a v0.1.4 database (test/fixtures/v0.1.4.sql, invented rows).
// New migrations are covered automatically: they must apply on top of v0.1.4 and keep its rows.
test('a v0.1.4 database takes every migration in place and keeps its rows', () => {
  const ids = MIGRATIONS.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort(), 'migrations run in file-number order');
  assert.equal(new Set(ids).size, ids.length);

  const v014 = new Database(':memory:');
  v014.exec(fs.readFileSync(new URL('./fixtures/v0.1.4.sql', import.meta.url), 'utf8'));
  const count = (t) => v014.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const before = Object.fromEntries(['documents', 'pages', 'items', 'item_mentions', 'runs', 'usage'].map((t) => [t, count(t)]));

  assert.deepEqual(migrate(v014), ids);
  assert.deepEqual(migrate(v014), [], 'a second start applies nothing');
  for (const [t, n] of Object.entries(before)) assert.equal(count(t), n, `${t} rows kept`);
  const it = v014.prepare('SELECT * FROM items WHERE code=1').get();
  assert.deepEqual([it.text, it.due_time, it.assignee, it.edited], ['Draft the fixture memo', '14:00', 'Pat', '["due_time","assignee"]']);
  MIGRATIONS[0].up(v014); // the baseline also runs on databases from before the runner, so it must be idempotent
  for (const [t, n] of Object.entries(before)) assert.equal(count(t), n, `${t} rows kept by a second baseline run`);
  v014.close();
});

// Pages read before migration 003 have no page_closes or page_tags rows. It fills both from what's stored, so the
// sensitivity filter can hide a page that closed restricted work, or was tagged restricted, before the upgrade.
test('pages read before the upgrade are linked to the items their text closes, and keep their tags', () => {
  const v014 = new Database(':memory:');
  v014.exec(fs.readFileSync(new URL('./fixtures/v0.1.4.sql', import.meta.url), 'utf8'));
  const item = v014.prepare(`INSERT INTO items (id, code, text, kind, tags, status, snooze_until, closed_by, close_evidence)
    VALUES (?, ?, ?, 'action', '[]', ?, ?, ?, ?)`);
  item.run('it_c', 3, 'Get the fixture quote', 'done', null, 'handwriting', '✓3');
  item.run('it_d', 4, 'Sign the fixture form', 'done', null, 'handwriting', '☑ Sign the fixture form');
  item.run('it_e', 5, 'Call the fixture lab', 'snoozed', '2026-10-23', null, null);
  item.run('it_f', 6, 'Order the fixture parts', 'dropped', null, 'handwriting', 'x6');
  item.run('it_g', 7, 'Book the fixture room', 'done', null, 'handwriting', 'marked on source page');
  item.run('it_h', 8, 'Paint the fixture shed', 'done', null, 'handwriting', '8 ✓');
  const page = v014.prepare(`INSERT INTO pages (id, doc_id, page_index, status, page_date, tags, transcription_md)
    VALUES (?, 'doc-todo', ?, 'transcribed', '2026-10-17', ?, ?)`);
  page.run('pg-a', 1, '["orchard"]', 'Quote: ✓3 came in at 4M');
  page.run('pg-b', 2, 'not json', '- ☑ Sign the fixture form\n- marked on source page');
  page.run('pg-c', 3, '[]', 'snooze 5 Fri\nx6, not needed\npaint shed 8 ✓ and 14 → Mon');
  page.run('pg-d', 4, '[]', 'Met 6 people, 3 said yes; box14 and Q3 → Q4 2x4 boards');
  migrate(v014);
  assert.deepEqual(v014.prepare('SELECT page_id, item_id FROM page_closes ORDER BY page_id, item_id').all().map((r) => `${r.page_id}:${r.item_id}`),
    ['pg-a:it_c', 'pg-b:it_d', 'pg-c:it_e', 'pg-c:it_f', 'pg-c:it_h'], 'no link from prose, or from the words Gleaner writes itself');
  assert.deepEqual(v014.prepare('SELECT page_id, tag FROM page_tags ORDER BY page_id, tag').all().map((r) => `${r.page_id}:${r.tag}`),
    ['pg-1:45Z', 'pg-1:widget-permits', 'pg-a:orchard']);
  v014.close();
});

// The service and a `docker exec … cli.js` starting on a new release: one process migrates between the other's
// check and its write lock. The second must re-check under the lock and apply nothing, not fail or apply twice.
test('two processes migrating one database at once apply each migration once', () => {
  const file = path.join(dataDir, 'race.db');
  const a = new Database(file);
  a.exec(fs.readFileSync(new URL('./fixtures/v0.1.4.sql', import.meta.url), 'utf8'));
  const b = new Database(file);
  const transaction = b.transaction.bind(b);
  let raced = false;
  b.transaction = (fn) => {
    const t = transaction(fn);
    return { immediate: () => { if (!raced) { raced = true; assert.deepEqual(migrate(a), MIGRATIONS.map((m) => m.id)); } return t.immediate(); } };
  };
  assert.deepEqual(migrate(b), [], 'b found every migration recorded once it held the lock');
  assert.ok(raced, 'the race happened inside b\'s run');
  assert.equal(a.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, MIGRATIONS.length);
  a.close(); b.close();
});
