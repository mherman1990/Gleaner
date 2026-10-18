// Spec step 2 acceptance: a cowork-notebook token (sensitivity normal) never gets restricted work back, through any
// endpoint. The fixture world has a restricted project, moonbase (aliases mb, lunar), and puts restricted content
// everywhere a client could reach it: a page tagged moonbase, an item on it, an item carried from it to a normal page,
// an item and a page carrying an alias stored before the registry, a closed and a snoozed restricted item, events, a
// run's detail, and the digest. Every GET route is swept, and every response body is searched for the markers.
// All content is invented.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempEnv } from './helpers.js';

const dataDir = tempEnv('sensitivity', { GLEANER_PORT: '0' });
const registryFile = path.join(dataDir, 'projects.yaml');
fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'registry.yaml'), registryFile);

const { paths } = await import('../src/config.js');
const { db, setItemStatus, startRun, endRun } = await import('../src/db.js');
const { applyPageResult } = await import('../src/pipeline/ledger.js');
const { writeDayFiles, writeOpenLoops } = await import('../src/output/markdown.js');
const { startServer, router } = await import('../src/server.js');
const { addToken } = await import('../src/auth.js');

// Restricted content carries one of these; nothing a normal-sensitivity client receives may.
const LEAK = /MARKER-LUNA|moonbase/i;

let n = 0;
async function page(date, tags, text, items) {
  const id = `pg${++n}`;
  db.prepare('INSERT OR IGNORE INTO documents (id, name) VALUES (?, ?)').run('doc1', 'Field notes');
  db.prepare(`INSERT INTO pages (id, doc_id, page_index, rm_hash, status) VALUES (?,?,?,?, 'rendered')`).run(id, 'doc1', n, `hash${n}`);
  const row = db.prepare('SELECT * FROM pages WHERE id=?').get(id);
  await reread(row, date, tags, text, items);
  return row;
}
const reread = (row, date, tags, text, items) => applyPageResult(row, {
  page_date: date, summary: `Summary: ${text}`, tags, transcription_md: text, legibility: 'high', uncertain_spans: [], closes: [],
  items: items.map((i) => ({ existing_item_id: null, kind: 'action', status: 'open', person: null, assignee: null, due: null,
    due_time: null, priority: false, tags: [], ...i })),
}, date);
const code = (text) => db.prepare('SELECT code FROM items WHERE text=?').get(text).code;

// Restricted: a page tagged moonbase, its items, and one carried from it to a normal page.
const moon = await page('2026-10-14', ['moonbase'], 'MARKER-LUNA-PAGE crater survey notes', [
  { text: 'Order regolith samples MARKER-LUNA-A' },
  { text: 'Confirm MARKER-LUNA-C launch window' },
  { text: 'Close the MARKER-LUNA-CLOSED file' },
  { text: 'Revisit MARKER-LUNA-SNOOZED later' },
]);
// Normal: a page with a visible item, the carried item, and one that was tagged moonbase and later wasn't.
const widgets = await page('2026-10-15', ['widget-report'], 'Widget draft notes', [
  { text: 'Send the widget draft' },
  { text: 'Confirm MARKER-LUNA-C launch window' }, // carried: same text, matched by the mock dedupe
  { text: 'Book the review room', tags: ['moonbase'] },
]);
await reread(widgets, '2026-10-15', ['widget-report'], 'Widget draft notes', [
  { text: 'Send the widget draft', existing_item_id: db.prepare('SELECT id FROM items WHERE text=?').get('Send the widget draft').id },
  { text: 'Confirm MARKER-LUNA-C launch window', existing_item_id: db.prepare('SELECT id FROM items WHERE text=?').get('Confirm MARKER-LUNA-C launch window').id },
  { text: 'Book the review room', existing_item_id: db.prepare('SELECT id FROM items WHERE text=?').get('Book the review room').id, tags: ['wr'] },
]);
// Stored before the registry, so not canonical: an item tagged with an alias, and a page tagged with another in caps.
const old = await page('2026-10-16', ['widget-report'], 'Gizmo numbers', [{ text: 'Check the MARKER-LUNA-D schedule' }, { text: 'File the gizmo numbers' }]);
db.prepare(`UPDATE items SET tags='["mb"]' WHERE text='Check the MARKER-LUNA-D schedule'`).run();
await page('2026-10-17', ['bridge-permit'], 'Permit call', [{ text: 'Call about the permit' }]);
await page('2026-10-17', ['orchard'], 'Orchard walk', []);
db.prepare(`UPDATE pages SET tags='["Lunar"]', transcription_md='MARKER-LUNA-P4 dust notes', summary='MARKER-LUNA-P4' WHERE id=?`).run(`pg${n}`);

setItemStatus(db.prepare('SELECT id FROM items WHERE code=?').get(code('Close the MARKER-LUNA-CLOSED file')).id, 'done', 'mayer');
setItemStatus(db.prepare('SELECT id FROM items WHERE code=?').get(code('Revisit MARKER-LUNA-SNOOZED later')).id, 'snoozed', 'mayer', null, '2999-01-01');
setItemStatus(db.prepare('SELECT id FROM items WHERE code=?').get(code('Send the widget draft')).id, 'done', 'mayer');
endRun(startRun('ingest:sync'), true, { note: 'MARKER-LUNA-RUN moonbase' });
writeDayFiles(['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
writeOpenLoops();
fs.writeFileSync(path.join(paths.out, 'digest-latest.md'), '# Today\n- #1 Order regolith samples MARKER-LUNA-A');

const notebook = addToken('cowork-notebook', { scopes: 'read', sensitivity: 'normal' });
const mayer = addToken('mayer', { scopes: 'all', sensitivity: 'all' });
const server = startServer();
await new Promise((r) => server.once('listening', r));
after(() => { server.close(); db.close(); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = (url, token, init = {}) => fetch(base + url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } });

const codes = db.prepare('SELECT code FROM items ORDER BY code').all().map((r) => r.code);
const dates = db.prepare('SELECT DISTINCT page_date FROM pages').all().map((r) => r.page_date);
// Requests that reach every GET route. A new GET route without an entry here fails the first test.
const PROBES = {
  '/items': ['', '?status=all', '?status=closed', '?status=snoozed', '?tag=moonbase', '?tag=mb', '?tag=LUNAR', '?tag=widget-report']
    .map((q) => `/api/items${q}`),
  '/items/:code': codes.map((c) => `/api/items/${c}`),
  '/open-loops.md': ['/api/open-loops.md'],
  '/digest/today': ['/api/digest/today'],
  '/notes': ['/api/notes?from=2026-10-01&to=2026-10-31', '/api/notes?from=2026-10-14&to=2026-10-14'],
  '/notes/:date': dates.map((d) => `/api/notes/${d}`),
  '/search': ['/api/search?q=', '/api/search?q=MARKER', '/api/search?q=crater', '/api/search?q=dust'],
  '/events': ['/api/events?since=2000-01-01', '/api/events?since=2000-01-01&client=mayer', '/api/events?since=2000-01-01&client=handwriting'],
  '/status': ['/api/status'],
};

test('every GET route is swept', () => {
  const routes = router().stack.filter((l) => l.route?.methods.get).map((l) => l.route.path);
  assert.deepEqual(routes.filter((p) => !PROBES[p]), [], 'add probes for these routes');
});

test('a normal-sensitivity token never gets restricted work back, from any GET route', async () => {
  const leaks = [];
  for (const url of Object.values(PROBES).flat()) {
    const res = await call(url, notebook);
    const body = await res.text();
    assert.ok([200, 403, 404].includes(res.status), `${url}: ${res.status} ${body}`);
    if (LEAK.test(body)) leaks.push(`${url}: ${body.match(LEAK)[0]}`);
  }
  assert.deepEqual(leaks, []);
});

test('the same requests with an "all" token do reach every piece of restricted content', async () => {
  let all = '';
  for (const url of Object.values(PROBES).flat()) all += await (await call(url, mayer)).text();
  for (const m of ['MARKER-LUNA-PAGE', 'MARKER-LUNA-A', 'MARKER-LUNA-C', 'MARKER-LUNA-CLOSED', 'MARKER-LUNA-SNOOZED', 'MARKER-LUNA-D',
    'MARKER-LUNA-P4', 'MARKER-LUNA-RUN', 'moonbase']) assert.ok(all.includes(m), `the fixture reaches ${m}`);
});

test('normal sensitivity still gets everything else', async () => {
  const items = await (await call('/api/items?status=all', notebook)).json();
  assert.deepEqual(items.map((i) => i.text).sort(), ['Book the review room', 'Call about the permit', 'File the gizmo numbers', 'Send the widget draft']);
  assert.match(await (await call('/api/notes/2026-10-15', notebook)).text(), /Widget draft notes/);
  assert.equal((await call('/api/notes/2026-10-14', notebook)).status, 404, 'a day with only restricted pages has no notes');
  assert.equal((await call(`/api/items/${code('Order regolith samples MARKER-LUNA-A')}`, notebook)).status, 404);
  assert.equal((await call('/api/digest/today', notebook)).status, 403);
  const status = await (await call('/api/status', notebook)).json();
  assert.equal(status.pages.reduce((s, p) => s + p.n, 0), 3, 'counts leave out the two restricted pages of five');
  const events = await (await call('/api/events?since=2000-01-01', notebook)).json();
  assert.ok(events.some((e) => e.item_code === code('Send the widget draft') && e.client === 'mayer' && e.new === 'done'));
  assert.ok(!events.some((e) => e.item_code === code('Book the review room')), 'an item once tagged moonbase keeps its history hidden');
});

test('a normal-sensitivity client can\'t change what it can\'t see', async () => {
  const writer = addToken('writer', { scopes: 'read,write', sensitivity: 'normal' });
  const hidden = code('Order regolith samples MARKER-LUNA-A');
  const res = await call(`/api/items/${hidden}`, writer, { method: 'POST', body: JSON.stringify({ status: 'done' }) });
  assert.equal(res.status, 404);
  assert.equal(db.prepare('SELECT status FROM items WHERE code=?').get(hidden).status, 'open');
  const own = await call(`/api/items/${code('Call about the permit')}`, writer, { method: 'POST', body: JSON.stringify({ due: '2026-10-30' }) });
  assert.equal(own.status, 200);
});

test('with no registry loaded, normal sensitivity is refused (503), not shown everything', async () => {
  const text = fs.readFileSync(registryFile, 'utf8');
  fs.rmSync(registryFile);
  try {
    for (const url of ['/api/items', '/api/open-loops.md', '/api/notes/2026-10-15', '/api/search?q=', '/api/events?since=2000-01-01', '/api/status']) {
      const res = await call(url, notebook);
      assert.equal(res.status, 503, url);
      assert.doesNotMatch(await res.text(), LEAK);
    }
    assert.equal((await call('/api/items', mayer)).status, 200, '"all" doesn\'t need the registry');
  } finally { fs.writeFileSync(registryFile, text); }
});
