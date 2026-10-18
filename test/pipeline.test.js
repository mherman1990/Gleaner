// End to end, offline: fixture notebooks → render (rmc + cairosvg) → mock transcription → ledger → markdown,
// then the digest, Today sheet, reminders, weekly review, and the HTTP API.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempEnv, copyFixtures, rendererMissing, pushSink } from './helpers.js';

const fx = copyFixtures();
const dataDir = tempEnv('pipeline', { GLEANER_FIXTURE_DIR: fx, GLEANER_API_TOKEN: 'test-token', GLEANER_PORT: '0' });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ notebooks: { taskLists: ['calls'] } }));
const skip = rendererMissing;

const { localDate, config } = await import('../src/config.js');
const { db } = await import('../src/db.js');
const { ingest, markForRetranscription } = await import('../src/pipeline/ingest.js');
const { morningDigest, reminderSweep, weeklyReview } = await import('../src/digest/digest.js');
const { startServer } = await import('../src/server.js');
const { exclusive, busy } = await import('../src/jobs.js');

const today = localDate();
const dayFile = path.join(dataDir, 'notes', today.slice(0, 4), `${today}.md`);
const count = (sql) => db.prepare(sql).get().n;

test('batch ingest renders, transcribes, and writes markdown', { skip }, async () => {
  const r = await ingest({ mode: 'batch' });
  assert.equal(r.docs, 2);
  assert.equal(r.rendered, 4, 'three pages with ink plus one typed-text-only page');
  assert.equal(r.failed, 0);
  // Mock: every page yields "Send Tom…" (deduped across pages) plus one page-specific item.
  assert.equal(count('SELECT COUNT(*) AS n FROM items'), 5);
  assert.equal(count(`SELECT COUNT(*) AS n FROM items WHERE text='Send Tom the 45Z comment draft'`), 1);
  assert.equal(count(`SELECT COUNT(*) AS n FROM batches WHERE status='ended'`), 1);
  assert.ok(fs.readFileSync(dayFile, 'utf8').includes('## Items from this day'));
  assert.ok(fs.existsSync(path.join(dataDir, 'notes', 'open-loops.md')));
});

test('a re-run with nothing changed does nothing', { skip }, async () => {
  const r = await ingest({ mode: 'sync' });
  assert.equal(r.pages, 0);
  assert.equal(r.created, 0);
});

test('an edited page is re-transcribed alone, without duplicate items', { skip }, async () => {
  fs.copyFileSync(path.join(fx, 'Daily/01.rm'), path.join(fx, 'Daily/02.rm'));
  const r = await ingest({ mode: 'sync' });
  assert.equal(r.pages, 1);
  assert.equal(r.created, 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM items'), 5);
});

test('only task-list notebooks are flagged to the model', { skip }, () => {
  const summaries = db.prepare(`SELECT d.name, p.summary FROM pages p JOIN documents d ON d.id=p.doc_id`).all();
  for (const { name, summary } of summaries) {
    assert.equal(summary.endsWith('(task list)'), name === 'Calls', `${name}: ${summary}`);
  }
});

test('retranscribe re-reads by notebook, date, or all, keeping item numbers', { skip }, async () => {
  const codes = () => db.prepare('SELECT code FROM items ORDER BY code').all().map((r) => r.code);
  const before = codes();
  assert.equal(markForRetranscription('nonexistent notebook'), 0);

  assert.equal(markForRetranscription('CALLS'), 1);
  let r = await ingest({ mode: 'sync' });
  assert.equal(r.pages, 1);
  assert.equal(r.created, 0);

  assert.equal(markForRetranscription(today), 4);
  r = await ingest({ mode: 'sync' });
  assert.equal(r.pages, 4);
  assert.equal(r.failed, 0);

  fs.rmSync(path.join(dataDir, 'renders'), { recursive: true, force: true }); // renders aren't backed up
  fs.mkdirSync(path.join(dataDir, 'renders'));
  assert.equal(markForRetranscription('all'), 4);
  r = await ingest({ mode: 'sync' });
  assert.equal(r.rendered, 4, 'missing renders are re-created');
  assert.equal(r.pages, 4);
  assert.deepEqual(codes(), before, 'no duplicates, no renumbering');
  assert.equal((await ingest({ mode: 'sync' })).pages, 0, 'nothing left to re-read');
});

test('digest writes markdown and pushes the Today PDF', { skip }, async () => {
  const d = await morningDigest({ push: true });
  assert.match(d.md, /^# Today — /);
  assert.equal(d.top.length, 3);
  assert.equal(d.pushed.tablet, 'ok');
  assert.deepEqual(d.pushed.notify, { teams: 'skipped', ntfy: 'skipped' });
  const pdf = fs.readFileSync(path.join(dataDir, 'out', 'fixture-tablet-upload.pdf'));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('reminder sweep nudges due items once per day', { skip }, async (t) => {
  const sink = await pushSink();
  t.after(() => { sink.close(); config.notify.ntfyUrl = ''; });
  config.notify.ntfyUrl = sink.url;
  assert.ok((await reminderSweep()).nudged > 0);
  assert.equal((await reminderSweep()).nudged, 0);
  assert.equal(sink.hits.length, 1);
});

test('weekly review is written to out/', { skip }, async () => {
  const w = await weeklyReview({ push: false });
  assert.ok(fs.existsSync(path.join(dataDir, 'out', `weekly-${today}.md`)));
  assert.match(w.md, /^# Weekly review/);
});

test('only one ingest runs at a time', async () => {
  let release;
  const first = exclusive('ingest:batch', () => new Promise((r) => (release = r)));
  assert.equal(busy(), 'ingest:batch');
  await assert.rejects(exclusive('ingest:sync', async () => {}), /busy: ingest:batch/);
  release();
  await first;
  assert.equal(busy(), null);
});

test('HTTP API: token, items, status changes, notes', { skip }, async (t) => {
  const server = startServer();
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: 'Bearer test-token' };
  const get = (p, h = auth) => fetch(base + p, { headers: h });
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await get('/health', {})).status, 200);
  assert.equal((await get('/api/items', {})).status, 401);
  assert.equal((await get('/api/items', { Authorization: 'Bearer wrong' })).status, 401);
  config.server.apiToken = '';
  assert.equal((await get('/api/items')).status, 503, 'without a token /api is closed, not open');
  config.server.apiToken = 'test-token';

  const items = await (await get('/api/items')).json();
  assert.equal(items.length, 5);
  assert.ok(Array.isArray(items[0].tags));
  assert.equal((await (await get('/api/items?tag=45Z')).json()).length, 1);

  const code = items.find((i) => i.text === 'Send Tom the 45Z comment draft').code;
  assert.equal((await post(`/api/items/${code}`, { status: 'nope' })).status, 400);
  assert.equal((await post(`/api/items/${code}`, { status: 'snoozed' })).status, 400);
  assert.equal((await post('/api/items/9999', { status: 'done' })).status, 404);
  const done = await (await post(`/api/items/${code}`, { status: 'done' })).json();
  assert.equal(done.status, 'done');
  assert.equal(done.closed_by, 'legacy', 'the GLEANER_API_TOKEN client');
  assert.match(fs.readFileSync(dayFile, 'utf8'), new RegExp(`#${code}\\*\\*.*\\*done\\*`), 'day file shows the new status');
  assert.ok(!(await (await get('/api/open-loops.md')).text()).includes(`#${code}**`));

  // Closed items can be listed and reopened.
  assert.deepEqual((await (await get('/api/items?status=closed')).json()).map((i) => i.code), [code]);
  assert.equal((await get('/api/items?status=bogus')).status, 400);
  const reopened = await (await post(`/api/items/${code}`, { status: 'open' })).json();
  assert.deepEqual([reopened.status, reopened.closed_at], ['open', null]);
  assert.equal((await (await get('/api/items')).json()).length, 5);

  // Edits: due date and time, assignee; with or without a status.
  assert.equal((await post(`/api/items/${code}`, {})).status, 400);
  assert.equal((await post(`/api/items/${code}`, { due_time: '25:00' })).status, 400);
  assert.equal((await post(`/api/items/${code}`, { due: 'Friday' })).status, 400);
  const edited = await (await post(`/api/items/${code}`, { due: '2026-10-23', due_time: '2pm', assignee: 'Jen', ignored: 1 })).json();
  assert.deepEqual([edited.due, edited.due_time, edited.assignee, edited.status], ['2026-10-23', '14:00', 'Jen', 'open']);
  assert.deepEqual(edited.edited, ['due', 'due_time', 'assignee']);
  assert.match(fs.readFileSync(dayFile, 'utf8'), new RegExp(`#${code}\\*\\*.*@Jen \\(due 2026-10-23 2pm\\)`), 'day file shows the edit');
  await post('/api/items/2', { due: null, assignee: 'Kelsey' });
  assert.match(await (await get('/api/open-loops.md')).text(), /## Waiting on others\n- \*\*#2\*\*.*@Kelsey/, 'assigned items are grouped as waiting on others');
  const snoozed = await (await post(`/api/items/${code}`, { status: 'snoozed', until: '2999-01-01', assignee: null })).json();
  assert.deepEqual([snoozed.status, snoozed.assignee], ['snoozed', null]);
  assert.deepEqual((await (await get('/api/items?status=snoozed')).json()).map((i) => i.code), [code]);
  await post(`/api/items/${code}`, { status: 'done' });

  assert.equal((await get(`/api/notes/${today}`)).status, 200);
  assert.equal((await get('/api/notes/..%2F..%2Fgleaner')).status, 400);
  assert.equal((await get('/api/notes?from=garbage')).status, 400);
  assert.equal((await get('/api/notes?from=2020-01-01&to=2026-01-01')).status, 400);
  assert.match(await (await get(`/api/notes?to=${today}`)).text(), /^---\ndate: /);
  assert.equal((await (await get('/api/search?q=Mock')).json()).length, 4);
  assert.equal((await get('/api/digest/today')).status, 200);

  const status = await (await get('/api/status')).json();
  assert.equal(status.busy, null);
  assert.ok(status.runs.length > 0);

  assert.equal((await get('/ui/api/items', {})).status, 200, 'UI mount relies on the Umbrel proxy for auth');
  assert.match(await (await get('/', {})).text(), /<title>Gleaner<\/title>/);
});

after(() => db.close());
