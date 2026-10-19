// A page's reading is applied all at once, after the one network call it needs (the Haiku dedupe): while that call
// is out, nothing of the new reading is visible; if it fails, or a write fails partway, nothing is written and the
// page is read again next run; and a change made to an item meanwhile (the UI closing it) is not undone by the erase
// pass. Real SDK, fake API. All content is invented.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempEnv } from './helpers.js';
import { fakeAnthropic } from './fakes/anthropic.js';

let duringDedupe = null; // a test's hook, run while the dedupe call is out; throwing makes the call fail
const fake = await fakeAnthropic(async (params, purpose) => {
  if (purpose !== 'dedupe') throw new Error(`unexpected ${purpose} call`);
  if (duringDedupe) await duringDedupe();
  return { matches: [] };
});
const dataDir = tempEnv('ledger-atomic', { GLEANER_LLM: 'live', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: fake.url });
fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'registry.yaml'), path.join(dataDir, 'projects.yaml'));
const { db, setItemStatus } = await import('../src/db.js');
const { applyPageResult } = await import('../src/pipeline/ledger.js');
const { visibility } = await import('../src/sensitivity.js');
after(() => { db.close(); fake.close(); });

let n = 0;
function newPage() {
  const id = `pg${++n}`;
  db.prepare('INSERT OR IGNORE INTO documents (id, name) VALUES (?, ?)').run('doc1', 'Field notes');
  db.prepare(`INSERT INTO pages (id, doc_id, page_index, rm_hash, status) VALUES (?,?,?,?, 'rendered')`).run(id, 'doc1', n, `hash${n}`);
  return db.prepare('SELECT * FROM pages WHERE id=?').get(id);
}
const item = (text, extra = {}) => ({ existing_item_id: null, text, kind: 'action', status: 'open', person: null, assignee: null,
  due: null, due_time: null, priority: false, tags: [], ...extra });
const read = (p, items, text = 'notes', tags = []) => applyPageResult(p, { page_date: '2026-10-18', summary: text, tags, transcription_md: text,
  legibility: 'high', uncertain_spans: [], items, closes: [] }, '2026-10-18');
const page = (id) => db.prepare('SELECT status, transcription_md, transcribed_hash FROM pages WHERE id=?').get(id);

test('while the dedupe call is out nothing of the new reading shows; if it fails, nothing is written', async () => {
  const p = newPage();
  await read(p, [item('Order the invented banners')]); // an open item, so the next page's new line needs a dedupe call
  const q = newPage();
  const line = 'Get the MARKER-LUNA lease term sheet #mb';
  let seen = null;
  duringDedupe = () => {
    seen = { page: page(q.id), notes: visibility('normal').page({ id: q.id }) && page(q.id).transcription_md };
    throw new Error('overloaded');
  };
  try {
    await assert.rejects(read(q, [item('Get the MARKER-LUNA lease term sheet', { tags: ['mb'] })], line, ['widget-report']), /overloaded|500/);
  } finally { duringDedupe = null; }
  assert.deepEqual(seen.page, { status: 'rendered', transcription_md: null, transcribed_hash: null }, 'mid-call: the page is as it was');
  assert.deepEqual(page(q.id), { status: 'rendered', transcription_md: null, transcribed_hash: null }, 'after: still unread, so it\'s read again');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM items WHERE text LIKE '%MARKER-LUNA%'`).get().n, 0);

  await read(q, [item('Get the MARKER-LUNA lease term sheet', { tags: ['mb'] })], line, ['widget-report']); // the next run
  assert.equal(page(q.id).status, 'transcribed');
  assert.equal(visibility('normal').page({ id: q.id }), false, 'and then hidden, with its restricted item');
});

test('an item closed in the UI while the dedupe call is out isn\'t then dropped as erased', async () => {
  const p = newPage();
  await read(p, [item('Return the folding tables')]);
  const id = db.prepare('SELECT id FROM items WHERE text=?').get('Return the folding tables').id;
  duringDedupe = () => { setItemStatus(id, 'done', 'ui'); };
  try {
    await read(p, [item('Book the van')]); // the tables line is gone from the page, and there's a new line
  } finally { duringDedupe = null; }
  assert.deepEqual(db.prepare('SELECT status, closed_by FROM items WHERE id=?').get(id), { status: 'done', closed_by: 'ui' });
  assert.deepEqual(db.prepare('SELECT client, field, new FROM events WHERE item_code=(SELECT code FROM items WHERE id=?) AND field=\'status\'').all(id),
    [{ client: 'ui', field: 'status', new: 'done' }]);
});

test('a write that fails partway through a page leaves nothing of it', async () => {
  const p = newPage();
  db.exec(`CREATE TEMP TRIGGER boom BEFORE INSERT ON items WHEN NEW.text LIKE '%BOOM%' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  try {
    await assert.rejects(read(p, [item('Prune the invented rows'), item('Get the MARKER-LUNA lease BOOM', { tags: ['mb'] })],
      'Prune the invented rows\nGet the MARKER-LUNA lease BOOM #mb', ['orchard']), /boom/);
  } finally { db.exec('DROP TRIGGER boom'); }
  assert.deepEqual(page(p.id), { status: 'rendered', transcription_md: null, transcribed_hash: null });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM items WHERE text='Prune the invented rows'`).get().n, 0, 'the first line\'s item is gone too');
  for (const t of ['item_mentions', 'page_closes', 'page_tags']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE page_id=?`).get(p.id).n, 0, t);
});
