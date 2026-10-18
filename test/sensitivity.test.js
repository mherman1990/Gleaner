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
const { applyPageResult, closedOnPage } = await import('../src/pipeline/ledger.js');
const { visibility } = await import('../src/sensitivity.js');
const Database = (await import('better-sqlite3')).default;
const { writeDayFiles, writeOpenLoops } = await import('../src/output/markdown.js');
const { startServer, router } = await import('../src/server.js');
const { addToken } = await import('../src/auth.js');

// Restricted content carries one of these; nothing a normal-sensitivity client receives may.
const LEAK = /MARKER-LUNA|moonbase/i;

let n = 0;
async function page(date, tags, text, items, closes = []) {
  const id = `pg${++n}`;
  db.prepare('INSERT OR IGNORE INTO documents (id, name) VALUES (?, ?)').run('doc1', 'Field notes');
  db.prepare(`INSERT INTO pages (id, doc_id, page_index, rm_hash, status) VALUES (?,?,?,?, 'rendered')`).run(id, 'doc1', n, `hash${n}`);
  const row = db.prepare('SELECT * FROM pages WHERE id=?').get(id);
  await reread(row, date, tags, text, items, closes);
  return row;
}
const reread = (row, date, tags, text, items, closes = []) => applyPageResult(row, {
  page_date: date, summary: `Summary: ${text.split('\n')[0]}`, tags, transcription_md: text, legibility: 'high', uncertain_spans: [], closes,
  items: items.map((i) => ({ existing_item_id: null, kind: 'action', status: 'open', person: null, assignee: null, due: null,
    due_time: null, priority: false, tags: [], ...i })),
}, date);
const code = (text) => db.prepare('SELECT code FROM items WHERE text=?').get(text).code;
const idOf = (text) => db.prepare('SELECT id FROM items WHERE text=?').get(text).id;
// A page's text is what the transcriber wrote down, so it holds its items' lines.
const lines = (title, items) => [title, ...items.map((i) => `- ☐ ${i.text}${i.mark ?? ''}`)].join('\n');

// Restricted: a page tagged moonbase and its items.
const moonItems = [{ text: 'Order regolith samples MARKER-LUNA-A' }, { text: 'Confirm MARKER-LUNA-C launch window' },
  { text: 'Close the MARKER-LUNA-CLOSED file' }, { text: 'Revisit MARKER-LUNA-SNOOZED later' }, { text: 'Sign the MARKER-LUNA-BOX form' }];
await page('2026-10-14', ['moonbase'], lines('MARKER-LUNA-PAGE crater survey', moonItems), moonItems);
// A normal page holding a line carried over from that page: hidden whole, though its other items stay visible. One of
// them was tagged moonbase at first and isn't any more.
const widgetItems = [{ text: 'Send the widget draft' }, { text: 'Confirm MARKER-LUNA-C launch window' }, { text: 'Book the review room', tags: ['moonbase'] }];
const widgets = await page('2026-10-15', ['widget-report'], lines('Widget draft', widgetItems), widgetItems);
await reread(widgets, '2026-10-15', ['widget-report'], lines('Widget draft', widgetItems),
  widgetItems.map((i) => ({ ...i, existing_item_id: idOf(i.text), tags: i.tags ? ['wr'] : [] })));
// A normal page holding an item tagged with an alias, stored before the registry existed (so not made canonical).
const oldItems = [{ text: 'Check the MARKER-LUNA-D schedule', mark: ' #mb' }, { text: 'File the gizmo numbers' }];
await page('2026-10-16', ['widget-report'], lines('Gizmo numbers', oldItems), oldItems);
db.prepare(`UPDATE items SET tags='["mb"]' WHERE text='Check the MARKER-LUNA-D schedule'`).run();
// Normal pages that stay visible.
await page('2026-10-17', ['bridge-permit'], lines('Permit call', [{ text: 'Call about the permit' }]), [{ text: 'Call about the permit' }]);
await page('2026-10-18', ['orchard'], lines('Orchard walk', [{ text: 'Prune the orchard rows' }]), [{ text: 'Prune the orchard rows' }]);
// Restricted pages: one tagged with an alias in other case, stored before the registry, and one that closes a visible
// item by number, in words of its own.
await page('2026-10-17', ['orchard'], 'Dust notes', []);
db.prepare(`UPDATE pages SET tags='["Lunar"]', transcription_md='MARKER-LUNA-P4 dust notes', summary='MARKER-LUNA-P4' WHERE id=?`).run(`pg${n}`);
const permit = code('Call about the permit');
await page('2026-10-18', ['moonbase'], `MARKER-LUNA-CLOSER ✓${permit} sent to the review board`, [],
  [{ code: permit, action: 'done', snooze_until: null, evidence: `✓${permit} MARKER-LUNA-EVIDENCE sent to the review board` }]);
// Normal pages that hold restricted work without a restricted tag of their own: a line tagged #mb, the same line
// carried forward a day later without the tag (the item stays restricted, and so do both pages), and a ticked box
// that closes a restricted item by its line.
const lease = [{ text: 'Get the MARKER-LUNA-L lease term sheet', tags: ['mb'], mark: ' #mb' }];
await page('2026-10-19', ['widget-report'], lines('Lease notes', lease), lease);
await page('2026-10-20', ['widget-report'], lines('Lease follow-up', [{ text: lease[0].text }]), [{ text: lease[0].text }]);
const box = code('Sign the MARKER-LUNA-BOX form');
await page('2026-10-20', ['orchard'], '☑ Sign the MARKER-LUNA-BOX form', [], [{ code: box, action: 'done', snooze_until: null, evidence: '☑' }]);

setItemStatus(idOf('Close the MARKER-LUNA-CLOSED file'), 'done', 'mayer');
setItemStatus(idOf('Revisit MARKER-LUNA-SNOOZED later'), 'snoozed', 'mayer', null, '2999-01-01');
setItemStatus(idOf('Send the widget draft'), 'done', 'mayer');
endRun(startRun('ingest:sync'), true, { note: 'MARKER-LUNA-RUN moonbase' });
writeDayFiles(['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20']);
writeOpenLoops();
fs.writeFileSync(path.join(paths.out, 'digest-latest.md'), '# Today\n- #1 Order regolith samples MARKER-LUNA-A');

const notebook = addToken('cowork-notebook', { scopes: 'read', sensitivity: 'normal' });
const mayer = addToken('mayer', { scopes: 'all', sensitivity: 'all' });
const server = startServer();
await new Promise((r) => server.once('listening', r));
after(() => { server.close(); db.close(); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = (url, token, init = {}) => fetch(base + url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } });

// Requests that reach every GET route, for every item and page date there is now. A new GET route without an entry
// here fails the first test.
const PROBES = () => ({
  '/items': ['', '?status=all', '?status=closed', '?status=snoozed', '?tag=moonbase', '?tag=mb', '?tag=LUNAR', '?tag=widget-report']
    .map((q) => `/api/items${q}`),
  '/items/:code': db.prepare('SELECT code FROM items ORDER BY code').all().map((r) => `/api/items/${r.code}`),
  '/open-loops.md': ['/api/open-loops.md'],
  '/digest/today': ['/api/digest/today'],
  '/notes': ['/api/notes?from=2026-10-01&to=2026-10-31', '/api/notes?from=2026-10-14&to=2026-10-14'],
  '/notes/:date': db.prepare('SELECT DISTINCT page_date FROM pages').all().map((r) => `/api/notes/${r.page_date}`),
  '/search': ['/api/search?q=', '/api/search?q=MARKER', '/api/search?q=crater', '/api/search?q=dust'],
  '/events': ['/api/events?since=2000-01-01', '/api/events?since=2000-01-01&client=mayer', '/api/events?since=2000-01-01&client=handwriting'],
  '/status': ['/api/status'],
});
/** What a normal-sensitivity token gets back from every route that it shouldn't. */
async function leaks() {
  const found = [];
  for (const url of Object.values(PROBES()).flat()) {
    const res = await call(url, notebook);
    const body = await res.text();
    assert.ok([200, 403, 404].includes(res.status), `${url}: ${res.status} ${body}`);
    if (LEAK.test(body)) found.push(`${url}: ${body.match(LEAK)[0]}`);
  }
  return found;
}

test('every GET route is swept', () => {
  const routes = router().stack.filter((l) => l.route?.methods.get).map((l) => l.route.path);
  assert.deepEqual(routes.filter((p) => !PROBES()[p]), [], 'add probes for these routes');
});

test('a normal-sensitivity token never gets restricted work back, from any GET route', async () => {
  assert.deepEqual(await leaks(), []);
});

test('the same requests with an "all" token do reach every piece of restricted content', async () => {
  let all = '';
  for (const url of Object.values(PROBES()).flat()) all += await (await call(url, mayer)).text();
  for (const m of ['MARKER-LUNA-PAGE', 'MARKER-LUNA-A', 'MARKER-LUNA-C', 'MARKER-LUNA-CLOSED', 'MARKER-LUNA-SNOOZED', 'MARKER-LUNA-D',
    'MARKER-LUNA-P4', 'MARKER-LUNA-CLOSER', 'MARKER-LUNA-EVIDENCE', 'MARKER-LUNA-L', 'MARKER-LUNA-BOX', 'MARKER-LUNA-RUN', 'moonbase']) assert.ok(all.includes(m), `the fixture reaches ${m}`);
});

test('normal sensitivity still gets everything else', async () => {
  const items = await (await call('/api/items?status=all', notebook)).json();
  assert.deepEqual(items.map((i) => i.text).sort(), ['Call about the permit', 'File the gizmo numbers', 'Prune the orchard rows', 'Send the widget draft'],
    'not "Book the review room": once tagged moonbase, it stays restricted after a re-read without the tag');
  const closed = items.find((i) => i.code === permit);
  assert.deepEqual([closed.status, closed.closed_by, closed.close_evidence], ['done', 'handwriting', null], 'closed, without the restricted page\'s words');
  assert.match(await (await call('/api/notes/2026-10-17', notebook)).text(), /Permit call/);
  assert.match(await (await call('/api/notes/2026-10-18', notebook)).text(), /Orchard walk/);
  for (const d of ['2026-10-14', '2026-10-15', '2026-10-16']) assert.equal((await call(`/api/notes/${d}`, notebook)).status, 404, `${d}: only hidden pages`);
  assert.equal((await call(`/api/items/${code('Order regolith samples MARKER-LUNA-A')}`, notebook)).status, 404);
  assert.equal((await call('/api/digest/today', notebook)).status, 403);
  const status = await (await call('/api/status', notebook)).json();
  assert.equal(status.pages.reduce((s, p) => s + p.n, 0), 2, 'counts leave out the eight hidden pages of ten');
  assert.equal(db.prepare(`SELECT tags FROM items WHERE text=?`).get(lease[0].text).tags, '[]', 'the carry did clear the item\'s tag');
  const events = await (await call('/api/events?since=2000-01-01', notebook)).json();
  assert.ok(events.some((e) => e.item_code === code('Send the widget draft') && e.client === 'mayer' && e.new === 'done'));
  assert.ok(!events.some((e) => e.item_code === code('Book the review room')), 'nor its history');
});

test('the digest is refused at normal even with the digest scope', async () => {
  const digester = addToken('digester', { scopes: 'all', sensitivity: 'normal' });
  for (const res of [await call('/api/digest/today', digester), await call('/api/digest', digester, { method: 'POST', body: '{}' })]) {
    assert.equal(res.status, 403);
    assert.doesNotMatch(await res.text(), LEAK);
  }
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

test('a re-read of a page that ticked off or closed restricted work keeps it hidden, and doesn\'t copy the ticked line', async () => {
  const moon = [{ text: 'Sign the MARKER-LUNA-TICK form' }, { text: 'Price the MARKER-LUNA-NUM rover' }];
  await page('2026-10-22', ['moonbase'], lines('MARKER-LUNA crater budget', moon), moon);
  const [tick, num] = moon.map((i) => code(i.text));
  const ticked = await page('2026-10-23', ['orchard'], '☑ Sign the MARKER-LUNA-TICK form', [], [{ code: tick, action: 'done', snooze_until: null, evidence: '☑' }]);
  const numbered = await page('2026-10-23', ['orchard'], `✓${num} MARKER-LUNA rover priced at 4M`, [], [{ code: num, action: 'done', snooze_until: null, evidence: `✓${num}` }]);
  // Both items are closed now, so they're no longer in the open list a re-read gets, and the model can't repeat the
  // closes. The prompt still lists the item each page closed, and the link from each page stays.
  assert.deepEqual(closedOnPage(ticked.id).map((i) => [i.text, i.status]), [['Sign the MARKER-LUNA-TICK form', 'done']]);
  await reread(ticked, '2026-10-23', ['orchard'], '☑ Sign the MARKER-LUNA-TICK form\n- ☐ Water the pear trees', [{ text: 'Water the pear trees' }]);
  await reread(numbered, '2026-10-23', ['orchard'], `✓${num} MARKER-LUNA rover priced at 4M`, []);
  const vis = visibility('normal');
  assert.equal(vis.page(ticked), false);
  assert.equal(vis.page(numbered), false);
  // The ticked line read as a done item without its item's id (the model missing the link) is that item, not a new one.
  await reread(ticked, '2026-10-23', ['orchard'], '☑ Sign the MARKER-LUNA-TICK form\n- ☐ Water the pear trees',
    [{ text: 'Sign the MARKER-LUNA-TICK form', status: 'done' }, { text: 'Water the pear trees', existing_item_id: idOf('Water the pear trees') }]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE text=?').get('Sign the MARKER-LUNA-TICK form').n, 1);
  assert.equal(visibility('normal').page(ticked), false);
  assert.deepEqual(await leaks(), []);
});

test('an open line written again on a page whose item for it is done is a new commitment', async () => {
  const press = [{ text: 'Rinse the cider press' }];
  const q = await page('2026-10-23', ['orchard'], lines('Cider', press), press);
  const id = idOf(press[0].text);
  await reread(q, '2026-10-23', ['orchard'], '☑ Rinse the cider press', [{ ...press[0], status: 'done', existing_item_id: id }]);
  await reread(q, '2026-10-23', ['orchard'], '☑ Rinse the cider press\n- ☐ Rinse the cider press', press); // the new line, without an id
  assert.deepEqual(db.prepare('SELECT status FROM items WHERE text=? ORDER BY code').all(press[0].text).map((i) => i.status), ['done', 'open']);
});

test('a restricted page stays restricted when a re-read misses its tag, or it is erased and written over', async () => {
  const budget = [{ text: 'Draft the MARKER-LUNA-Q budget note' }];
  const p = await page('2026-10-24', ['moonbase'], lines('MARKER-LUNA-Q budget', budget), budget);
  await page('2026-10-25', ['widget-report'], lines('Carried', budget), budget); // carried to a normal page
  // The model doesn't tag the page this time, though the line is the same.
  await reread(p, '2026-10-24', [], lines('MARKER-LUNA-Q budget', budget), [{ ...budget[0], existing_item_id: idOf(budget[0].text) }]);
  const erased = [{ text: 'Sign the MARKER-LUNA-ERASED lease' }];
  const e = await page('2026-10-26', ['moonbase'], lines('MARKER-LUNA-ERASED lease', erased), erased);
  await reread(e, '2026-10-26', ['orchard'], lines('Orchard fence', [{ text: 'Mend the orchard fence' }]), [{ text: 'Mend the orchard fence' }]);
  assert.equal(db.prepare('SELECT status FROM items WHERE text=?').get(erased[0].text).status, 'dropped', 'erased from the page');
  const vis = visibility('normal');
  for (const row of [p, e]) assert.equal(vis.page(row), false, row.id);
  for (const text of [budget[0].text, erased[0].text, 'Mend the orchard fence']) assert.equal(vis.item({ id: idOf(text) }), false, text);
  assert.deepEqual(await leaks(), []);
});

test('a line moved off a restricted page stays hidden, and so does the page it moved to', async () => {
  const crates = [{ text: 'Order the MARKER-LUNA-MOVED crates' }, { text: 'Count the MARKER-LUNA-STAY rovers' }];
  const q = await page('2026-10-27', ['moonbase'], lines('MARKER-LUNA crates', crates), crates);
  const stay = { ...crates[1], existing_item_id: idOf(crates[1].text) };
  await reread(q, '2026-10-27', ['moonbase'], lines('MARKER-LUNA crates', [stay]), [stay]); // cut from here…
  const p = await page('2026-10-28', ['orchard'], lines('Orchard', [crates[0]]), [crates[0]]); // …and pasted here, untagged
  const moved = db.prepare('SELECT id, status FROM items WHERE text=?').all(crates[0].text);
  assert.deepEqual(moved.map((i) => i.status), ['open'], 'the same item, open again, not a new one');
  const vis = visibility('normal');
  assert.equal(vis.item(moved[0]), false);
  assert.equal(vis.page(p), false);
  assert.deepEqual(await leaks(), []);
});

test('rows written after the judgement are hidden until the next one', () => {
  const vis = visibility('normal');
  db.prepare(`INSERT INTO pages (id, doc_id, page_index, rm_hash, status, tags) VALUES ('pg-late', 'doc1', 99, 'late', 'transcribed', '["orchard"]')`).run();
  db.prepare(`INSERT INTO items (id, code, text, kind, tags, status) VALUES ('it_late', 9999, 'Rake the late leaves', 'action', '[]', 'open')`).run();
  assert.deepEqual([vis.page({ id: 'pg-late' }), vis.item({ id: 'it_late' }), vis.code(9999)], [false, false, false]);
  const next = visibility('normal');
  assert.deepEqual([next.page({ id: 'pg-late' }), next.item({ id: 'it_late' }), next.code(9999)], [true, true, true]);
});

// Another process (a `docker exec … cli.js ingest`) writes just before `sql` is first run in this one.
function writeBefore(sql, write) {
  const other = new Database(path.join(dataDir, 'gleaner.db'), { timeout: 50 });
  const prepare = db.prepare;
  const result = { wrote: false };
  db.prepare = function (text, ...rest) {
    if (text.includes(sql)) {
      db.prepare = prepare;
      try { write(other); result.wrote = true; } catch (e) { result.error = e.code; }
    }
    return prepare.call(this, text, ...rest);
  };
  result.done = () => { db.prepare = prepare; other.close(); };
  return result;
}

test('a read sees one snapshot: a page another process makes restricted mid-request doesn\'t show its new text', async () => {
  const orchard = db.prepare(`SELECT * FROM pages WHERE transcription_md LIKE '%Orchard walk%'`).get();
  const w = writeBefore('FROM page_closes', (other) => other.prepare(`UPDATE pages SET tags='["moonbase"]', transcription_md=? WHERE id=?`)
    .run('Orchard walk MARKER-LUNA-RACE', orchard.id));
  try {
    let body;
    try { body = await (await call('/api/notes/2026-10-18', notebook)).text(); } finally { w.done(); }
    assert.ok(w.wrote, 'the other process wrote while the request was being answered');
    assert.doesNotMatch(body, LEAK);
    assert.equal(visibility('normal').page(orchard), false, 'and the next request hides the page');
  } finally { // the page as it was, for the tests after this one
    db.prepare('UPDATE pages SET tags=?, transcription_md=? WHERE id=?').run(orchard.tags, orchard.transcription_md, orchard.id);
  }
});

test('a change checks and changes the item under one lock: another process can\'t make it restricted in between', async () => {
  const writer = addToken('race-writer', { scopes: 'read,write', sensitivity: 'normal' });
  const c = code('Prune the orchard rows');
  const w = writeBefore('SELECT * FROM items WHERE code=?', (other) => other.prepare(`UPDATE items SET tags='["moonbase"]', text='Prune the MARKER-LUNA-RACE rows' WHERE code=?`).run(c));
  let res;
  try { res = await call(`/api/items/${c}`, writer, { method: 'POST', body: JSON.stringify({ due: '2026-11-02' }) }); } finally { w.done(); }
  assert.equal(w.error, 'SQLITE_BUSY', 'the other process had to wait');
  assert.equal(res.status, 200);
  assert.doesNotMatch(await res.text(), LEAK);
});

// Last: it adds 740 items, which the sweeps above would request one by one.
test('a normal client still gets the latest items it may see, and a tag\'s older ones, however many newer items there are', async () => {
  await page('2026-10-21', ['bridge-permit'], lines('Permit paperwork', [{ text: 'File the permit paperwork', mark: ' #bp' }]),
    [{ text: 'File the permit paperwork', tags: ['bp'] }]);
  setItemStatus(idOf('File the permit paperwork'), 'done', 'mayer');
  const insert = db.prepare(`INSERT INTO items (id, code, text, kind, tags, status, closed_at, closed_by) VALUES (?,?,?,'action',?,?,?,?)`);
  const top = db.prepare('SELECT MAX(code) AS n FROM items').get().n;
  const later = (i) => new Date(Date.now() + i * 1000).toISOString();
  // Newer than every visible item: 120 restricted closes (the closed list's cap is 100) and 500 restricted items
  // (the full list's cap).
  for (let i = 1; i <= 120; i++) insert.run(`it_bulk${i}`, top + i, `Bulk MARKER-LUNA close ${i}`, '["moonbase"]', 'done', later(i), 'mayer');
  for (let i = 1; i <= 500; i++) insert.run(`it_open${i}`, top + 120 + i, `Bulk MARKER-LUNA item ${i}`, '["moonbase"]', 'open', null, null);
  const closed = await (await call('/api/items?status=closed', notebook)).json();
  assert.ok(closed.some((i) => i.code === permit), 'the closed list\'s cap applies after the filter');
  const all = await (await call('/api/items?status=all', notebook)).json();
  assert.ok(all.some((i) => i.code === permit), 'and the full list\'s');
  assert.doesNotMatch(JSON.stringify([closed, all]), LEAK);
  // And 120 newer closes of another project, which a normal client may see.
  for (let i = 1; i <= 120; i++) insert.run(`it_wr${i}`, top + 620 + i, `Bulk widget close ${i}`, '["widget-report"]', 'done', later(200 + i), 'mayer');
  for (const [url, token] of [['/api/items?status=closed&tag=bridge-permit', notebook], ['/api/items?status=closed&tag=BP', notebook], ['/api/items?status=all&tag=bp', mayer]]) {
    assert.deepEqual((await (await call(url, token)).json()).map((i) => i.text), ['File the permit paperwork'], `${url}: the tag applies before the cap`);
  }
});
