// Step 4 acceptance (spec §1.5): GET /api/projects/:tag matches a hand count of the fixture. Built from pages read
// through the ledger and an item created through the API, with tags written as aliases and stored before an alias
// existed, dates around the windows' edges, and restricted work mixed in. An item with no project tag of its own
// belongs to its page's projects; one with its own belongs to those. No LLM. All content is invented.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempEnv } from './helpers.js';

const dataDir = tempEnv('projects', { GLEANER_PORT: '0' });
fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'registry.yaml'), path.join(dataDir, 'projects.yaml'));

const { localDate } = await import('../src/config.js');
const { db, setItemStatus } = await import('../src/db.js');
const { applyPageResult } = await import('../src/pipeline/ledger.js');
const { addDays } = await import('../src/digest/digest.js');
const { startServer } = await import('../src/server.js');
const { addToken } = await import('../src/auth.js');

const server = startServer();
await new Promise((r) => server.once('listening', r));
after(() => { server.close(); db.close(); });
const base = `http://127.0.0.1:${server.address().port}`;
const all = addToken('mayer', { scopes: 'all', sensitivity: 'all' });
const normal = addToken('cowork-notebook', { scopes: 'read', sensitivity: 'normal' });
const get = async (url, token = all) => { const res = await fetch(base + url, { headers: { Authorization: `Bearer ${token}` } }); return { status: res.status, body: await res.json() }; };

const today = localDate();
const ago = (n) => addDays(today, -n);
let n = 0;
async function page(date, tags, items, notebook = 'Field notes') {
  const id = `pg${++n}`;
  db.prepare('INSERT OR IGNORE INTO documents (id, name) VALUES (?, ?)').run(notebook, notebook);
  db.prepare(`INSERT INTO pages (id, doc_id, page_index, rm_hash, status) VALUES (?,?,?,?, 'rendered')`).run(id, notebook, n, `hash${n}`);
  await applyPageResult(db.prepare('SELECT * FROM pages WHERE id=?').get(id), {
    page_date: date, summary: `Summary ${n}: ${items[0]?.text ?? 'notes'}`, tags, transcription_md: items.map((i) => `- ${i.text}`).join('\n') || 'notes',
    legibility: 'high', uncertain_spans: [], closes: [],
    items: items.map((i) => ({ existing_item_id: null, kind: 'action', status: 'open', person: null, assignee: null, due: null,
      due_time: null, priority: false, tags: [], ...i })),
  }, date);
  return id;
}
const item = (text) => db.prepare('SELECT * FROM items WHERE text=?').get(text);

// bridge-permit, written as its tag, as aliases (bp, 1.10), and once stored raw before the registry canonicalized it.
await page(ago(2), ['bridge-permit'], [
  { text: 'Call the county about the invented permit', due: ago(1) },                 // open, overdue, carried 4 days
  { text: 'Sam sends the invented traffic study', kind: 'waiting' },                   // open, waiting
  { text: 'Apply for the two-lane invented permit', kind: 'decision' },                // open, decision in 90 days
  { text: 'Does the invented permit cover the north span?', kind: 'question' },        // open, question
  { text: 'Print the invented permit map' },                                           // closed today
  { text: 'Revisit the invented permit fee' },                                         // snoozed: not open
  { text: 'Send the invented widget numbers', tags: ['wr'] },                          // its own tag: widget-report only
]);
await page(ago(40), ['bp'], [
  { text: 'Draft the invented permit letter' },                                        // open (page outside the window)
  { text: 'Hold the invented hearing in spring', kind: 'decision' },                   // decision in 90 days, closed 35 days ago
]);
await page(ago(100), ['bridge-permit'], [{ text: 'Drop the invented toll idea', kind: 'decision' }]); // open, decision too old
await page(ago(5), ['moonbase'], [{ text: 'Check the MARKER-LUNA permit overlap', tags: ['bp'] }]);  // restricted, open
await page(ago(3), ['widget-report'], [{ text: 'Send the invented widget draft' }, { text: 'Fly the invented kite', tags: ['kitesurf'] }]);
await page(ago(1), ['kitesurf'], [], 'Sketchbook');
db.prepare(`UPDATE items SET carry_days=4 WHERE text='Call the county about the invented permit'`).run();
db.prepare(`UPDATE items SET tags='["1.10"]' WHERE text='Draft the invented permit letter'`).run(); // as stored before the registry
setItemStatus(item('Print the invented permit map').id, 'done', 'ui');
setItemStatus(item('Revisit the invented permit fee').id, 'snoozed', 'ui', null, addDays(today, 10));
setItemStatus(item('Hold the invented hearing in spring').id, 'done', 'ui');
db.prepare(`UPDATE items SET closed_at=? WHERE text='Hold the invented hearing in spring'`).run(new Date(Date.now() - 35 * 864e5).toISOString());
const created = await fetch(`${base}/api/items`, { method: 'POST', headers: { Authorization: `Bearer ${all}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'Email the invented permit office', tags: ['BP'], source: 'email', source_ref: 'm-1' }) });
assert.equal(created.status, 201);

const texts = (list) => list.map((i) => i.text).sort();

test('/api/projects/bridge-permit matches a hand count of the fixture', async () => {
  const { status, body: p } = await get('/api/projects/bridge-permit');
  assert.equal(status, 200);
  assert.deepEqual([p.project.tag, p.project.name, p.days, p.since], ['bridge-permit', 'Bridge permit bill', 30, ago(29)]);
  const open = ['Call the county about the invented permit', 'Sam sends the invented traffic study', 'Apply for the two-lane invented permit',
    'Does the invented permit cover the north span?', 'Draft the invented permit letter', 'Drop the invented toll idea',
    'Check the MARKER-LUNA permit overlap', 'Email the invented permit office'];
  assert.deepEqual(texts(Object.values(p.open).flat()), [...open].sort());
  assert.deepEqual(Object.keys(p.open).sort(), ['action', 'decision', 'question', 'waiting']);
  assert.deepEqual(texts(p.open.decision), ['Apply for the two-lane invented permit', 'Drop the invented toll idea']);
  assert.deepEqual(texts(p.waiting), ['Sam sends the invented traffic study']);
  assert.deepEqual(texts(p.questions), ['Does the invented permit cover the north span?']);
  assert.deepEqual(p.decisions.map((i) => i.text), ['Apply for the two-lane invented permit', 'Hold the invented hearing in spring'],
    'the last 90 days, newest first, closed ones included');
  assert.deepEqual(p.pages, [{ page_date: ago(2), notebook: 'Field notes', page: 2, summary: 'Summary 1: Call the county about the invented permit' }]);
  assert.deepEqual(texts(p.closed), ['Print the invented permit map']);
  assert.deepEqual([p.waiting.length, p.overdue, p.carried_max, p.last_activity], [1, 1, 4, today]);
  assert.ok(p.open.action.every((i) => Array.isArray(i.tags) && Array.isArray(i.unregistered_tags)), 'items come as the API gives them');
});

test('the window and the tag: days moves the window, an alias or case variant is the same project, others are refused', async () => {
  assert.deepEqual((await get('/api/projects/bridge-permit?days=3')).body.pages.map((pg) => pg.page_date), [ago(2)]);
  assert.deepEqual((await get('/api/projects/bridge-permit?days=2')).body.pages, [], 'two days: yesterday and today');
  assert.deepEqual(texts((await get('/api/projects/bridge-permit?days=45')).body.closed),
    ['Hold the invented hearing in spring', 'Print the invented permit map']);
  const canonical = (await get('/api/projects/bridge-permit')).body;
  for (const alias of ['bp', '%23BP', '1.10', 'Bridge-Permit']) assert.deepEqual((await get(`/api/projects/${alias}`)).body, canonical, alias);
  for (const [url, code] of [['/api/projects/kitesurf', 404], ['/api/projects/phone', 404], ['/api/projects/nothing', 404],
    ['/api/projects/bridge-permit?days=0', 400], ['/api/projects/bridge-permit?days=366', 400], ['/api/projects/bridge-permit?days=1.5', 400]]) {
    assert.equal((await get(url)).status, code, url);
  }
});

test('/api/projects lists every project with its counts, and the tags the registry doesn\'t cover', async () => {
  const { body } = await get('/api/projects');
  assert.deepEqual(body.projects.map((p) => p.tag), ['widget-report', 'bridge-permit', 'moonbase', 'orchard']);
  const bp = body.projects.find((p) => p.tag === 'bridge-permit');
  assert.deepEqual([bp.open, bp.waiting, bp.overdue, bp.carried_max, bp.last_activity], [8, 1, 1, 4, today]);
  assert.deepEqual(bp.aliases, ['404', '1.10', '0707', 'bp']);
  assert.equal(body.projects.find((p) => p.tag === 'widget-report').open, 3, 'the widget page\'s two, and the line tagged wr on the permit page');
  const orchard = body.projects.find((p) => p.tag === 'orchard');
  assert.deepEqual([orchard.open, orchard.carried_max, orchard.last_activity], [0, null, null]);
  assert.deepEqual(body.unregistered, [{ tag: 'kitesurf', items: 1, pages: 1, count: 2 }]);
  assert.equal(body.programs.alpha.name, 'Program Alpha');
});

test('at sensitivity normal, a restricted project isn\'t there and its work isn\'t counted', async () => {
  const { body } = await get('/api/projects', normal);
  assert.deepEqual(body.projects.map((p) => p.tag), ['widget-report', 'bridge-permit', 'orchard']);
  assert.equal(body.projects.find((p) => p.tag === 'bridge-permit').open, 7);
  const p = (await get('/api/projects/bridge-permit', normal)).body;
  assert.ok(!JSON.stringify(p).match(/MARKER-LUNA|moonbase/i));
  assert.equal(Object.values(p.open).flat().length, 7);
  for (const tag of ['moonbase', 'mb', 'LUNAR']) assert.equal((await get(`/api/projects/${tag}`, normal)).status, 404, tag);
  assert.equal((await get('/api/projects/moonbase')).status, 200, 'an "all" token sees it');
});
