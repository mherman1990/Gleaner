// Step 4 acceptance (spec §1.6): a failing tablet sign-in raises one alert at the first check, none for the next 6
// hours (simulated clock), then one again; an alert counts only once a channel accepted it. Each other condition is
// checked with injected readings, and GET /api/health reports without detail text at sensitivity normal. No LLM.
// All content is invented.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempEnv, pushSink } from './helpers.js';

const sink = await pushSink();
const dataDir = tempEnv('health', { GLEANER_PORT: '0', GLEANER_NTFY_URL: sink.url });
fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'registry.yaml'), path.join(dataDir, 'projects.yaml'));

const { config, localTime } = await import('../src/config.js');
const { db, logUsage } = await import('../src/db.js');
const health = await import('../src/health.js');
const { startServer } = await import('../src/server.js');
const { exclusive } = await import('../src/jobs.js');
const { addToken } = await import('../src/auth.js');

const server = startServer();
await new Promise((r) => server.once('listening', r));
const failing = await pushSink(500);
after(() => { server.close(); db.close(); sink.close(); failing.close(); });
const base = `http://127.0.0.1:${server.address().port}`;
const all = addToken('mayer', { scopes: 'all', sensitivity: 'all' });
const normal = addToken('cowork-notebook', { scopes: 'read', sensitivity: 'normal' });

/** The instant it's hh:mm local time on day (YYYY-MM-DD). */
const local = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(health.sixAm(new Date(`${day}T18:00:00Z`)).getTime() + ((h - 6) * 60 + m) * 60000);
};
const HOST = { memory: { available_mb: 2000, swap_total_mb: 2048, swap_used_pct: 5 }, disk: { path: '/data', free_gb: 50 } };
const ok = async () => ({ ok: true, detail: 'listed /Daily' });
const signedOut = async () => ({ ok: false, detail: 'rmapi ls /Daily: not signed in' });
const reading = (r, condition) => r.find((x) => x.condition === condition);
const run = (kind, started, ended, okay, detail = null) =>
  db.prepare('INSERT INTO runs (kind, started_at, ended_at, ok, detail) VALUES (?,?,?,?,?)').run(kind, started.toISOString(), ended?.toISOString() ?? null, okay, detail);

test('a failing sign-in raises one alert at the first check, none for the next 6 hours, then one again', async () => {
  const start = local('2030-03-04', '07:00');
  const check = (minutes, authCheck = signedOut) => health.checkHealth({ at: new Date(start.getTime() + minutes * 60000), authCheck, host: HOST, uptimeHours: 1 });
  const first = await check(0);
  assert.deepEqual([first.active, first.sent], [['source_auth'], ['source_auth']]);
  assert.equal(sink.hits.length, 1);
  assert.match(sink.hits[0].title, /Can't reach the tablet's notes/);
  assert.match(sink.hits[0].body, /not signed in.*sign in again/s);
  for (let m = 15; m < 360; m += 15) assert.deepEqual((await check(m)).sent, [], `${m} minutes later`);
  assert.equal(sink.hits.length, 1, 'quiet for 6 hours');
  assert.deepEqual((await check(360)).sent, ['source_auth']);
  assert.equal(sink.hits.length, 2);
  const row = db.prepare(`SELECT * FROM alerts WHERE condition='source_auth'`).get();
  assert.deepEqual([row.active, row.first_seen, row.last_sent], [1, start.toISOString(), new Date(start.getTime() + 360 * 60000).toISOString()]);

  assert.deepEqual((await check(375, ok)).active, [], 'signed in again');
  assert.deepEqual(db.prepare(`SELECT active, first_seen FROM alerts WHERE condition='source_auth'`).get(), { active: 0, first_seen: null });
  assert.deepEqual((await check(390)).sent, [], 'failing again within 6 hours of the last alert: still quiet');
});

test('an alert counts only once a channel accepted it, and one message lists every condition that\'s due', async () => {
  const at = local('2030-04-01', '09:00');
  const host = { memory: { available_mb: 300, swap_total_mb: 0, swap_used_pct: 0 }, disk: { path: '/data', free_gb: 1.5 } };
  const url = config.notify.ntfyUrl;
  try {
    config.notify.ntfyUrl = failing.url;
    const refused = await health.checkHealth({ at, authCheck: ok, host, uptimeHours: 1 });
    assert.deepEqual([refused.sent, refused.due.sort()], [[], ['disk', 'memory']]);
    config.notify.ntfyUrl = '';
    assert.deepEqual((await health.checkHealth({ at: new Date(at.getTime() + 15 * 60000), authCheck: ok, host, uptimeHours: 1 })).sent, [],
      'no channel set up: nothing is used up');
  } finally { config.notify.ntfyUrl = url; }
  const before = sink.hits.length;
  const sent = await health.checkHealth({ at: new Date(at.getTime() + 30 * 60000), authCheck: ok, host, uptimeHours: 1 });
  assert.deepEqual(sent.sent.sort(), ['disk', 'memory']);
  assert.equal(sink.hits.length, before + 1, 'one message');
  assert.match(sink.hits.at(-1).title, /2 problems/);
  assert.match(sink.hits.at(-1).body, /300 MB available[\s\S]*1\.5 GB free/);
});

test('memory and disk, from injected readings', () => {
  const at = local('2030-05-01', '10:00');
  const of = (host, c) => reading(health.evaluate({ at, host, uptimeHours: 1 }), c);
  assert.equal(of({ ...HOST, memory: { available_mb: 399, swap_used_pct: 0 } }, 'memory').active, true);
  assert.equal(of({ ...HOST, memory: { available_mb: 400, swap_used_pct: 51 } }, 'memory').active, true);
  assert.equal(of({ ...HOST, memory: { available_mb: 400, swap_used_pct: 50 } }, 'memory').active, false);
  assert.equal(of({ ...HOST, memory: null }, 'memory'), undefined, 'not Linux: not checked');
  assert.equal(of({ ...HOST, disk: { path: '/data', free_gb: 1.99 } }, 'disk').active, true);
  assert.equal(of(HOST, 'disk').active, false);
  assert.deepEqual(health.parseMeminfo('MemTotal:  8000000 kB\nMemFree: 100 kB\nMemAvailable:  409600 kB\nSwapTotal:  2097152 kB\nSwapFree:  1048576 kB\n'),
    { available_mb: 400, swap_total_mb: 2048, swap_used_pct: 50 });
  assert.equal(health.parseMeminfo('no such fields'), null);
});

test('spend: priced by model family, cache and batch rates, and a spike only over 3× the daily average and the floor', () => {
  assert.deepEqual(health.priceOf('claude-sonnet-5-5-20261001'), config.prices.models['claude-sonnet-5-5']);
  assert.deepEqual(health.priceOf('claude-mystery-9'), config.prices.models['claude-opus-5-5'], 'unknown: the dearest');
  // Usage rows at chosen times: logUsage stamps now(), so move each row to its time.
  const at = local('2031-01-31', '12:00');
  const use = (model, usage, batch, hoursBefore) => {
    logUsage(model, 'test', usage, batch);
    db.prepare('UPDATE usage SET at=? WHERE id=(SELECT MAX(id) FROM usage)').run(new Date(at.getTime() - hoursBefore * 3600e3).toISOString());
  };
  use('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 }, false, 1);
  assert.deepEqual(health.spend(new Date(at - 24 * 3600e3), at).usd, 2 + 0.2 + 2.5, 'input, cache read, cache write at 1.25×');
  use('claude-haiku-5-5', { input_tokens: 0, output_tokens: 1e6 }, true, 2);
  assert.equal(health.spend(new Date(at - 24 * 3600e3), at).usd, 4.7 + 0.25, 'batch at half price');
  const spike = () => reading(health.evaluate({ at, host: HOST, uptimeHours: 1 }), 'spend');
  assert.equal(spike().active, true, '$4.95 today against a 30-day average of $0.17');
  for (let d = 2; d <= 29; d++) use('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 0 }, false, d * 24); // $2 a day before
  assert.equal(spike().active, false, '$4.95 against an average of about $2.04: under 3×');
  const quiet = local('2032-06-01', '12:00');
  db.prepare('INSERT INTO usage (at, model, purpose, batch, input_tokens, output_tokens, cache_read, cache_write) VALUES (?,?,?,?,?,?,?,?)')
    .run(new Date(quiet - 3600e3).toISOString(), 'claude-sonnet-5-5', 'test', 0, 1e5, 0, 0, 0);
  assert.equal(reading(health.evaluate({ at: quiet, host: HOST, uptimeHours: 1 }), 'spend').active, false, '$0.20: under the $0.25 floor');
});

test('two failed runs in a row, and last night\'s batch, from the runs table', () => {
  const day = '2033-02-10', at = local(day, '07:00'), prev = local('2033-02-09', '21:30');
  const of = (c, opts = {}) => reading(health.evaluate({ at, host: HOST, uptimeHours: 30, ...opts }), c);
  assert.equal(of('batch_late').active, true, 'no batch run last night, with the service up all night');
  assert.match(of('batch_late').detail, /no nightly batch/);
  assert.equal(of('batch_late', { uptimeHours: 2 }).active, false, 'started this morning: it couldn\'t have run');

  run('ingest:batch', prev, null, null);
  assert.match(of('batch_late').detail, /still running/);
  db.prepare(`UPDATE runs SET ended_at=?, ok=0, detail='Error: batch expired\n  at x' WHERE id=(SELECT MAX(id) FROM runs)`).run(local(day, '00:30').toISOString());
  assert.match(of('batch_late').detail, /failed: Error: batch expired$/);
  run('ingest:sync', local(day, '06:15'), local(day, '06:20'), 0, 'Error: no API key');
  assert.equal(of('runs_failed').active, true);
  assert.match(of('runs_failed').detail, /ingest:sync at 06:15: Error: no API key; ingest:batch at 21:30: Error: batch expired/);
  run('ingest:batch', local('2033-02-09', '23:00'), local(day, '01:00'), 1);
  assert.equal(of('batch_late').active, false, 'a later batch run last night finished');
  assert.equal(of('runs_failed').active, false, 'the last two runs didn\'t both fail');

  run('ingest:batch', local(day, '21:30'), null, null);
  assert.equal(of('batch_late', { at: local(day, '21:45') }).active, false, 'tonight\'s batch is judged tomorrow');
  assert.equal(of('batch_late', { at: local('2033-02-11', '05:59') }), undefined, 'before 6:00am it isn\'t checked');
  assert.equal(of('batch_late', { at: local('2033-02-11', '06:00') }).active, true, 'by 6:00am it should have finished');
});

test('the scheduled check runs from 6:00am to 10:00pm, and leaves the sign-in alone while an ingest runs', async () => {
  const opts = { authCheck: ok, host: HOST, uptimeHours: 1 };
  for (const t of ['05:59', '22:01', '22:45']) assert.match((await health.healthCheckJob({ at: local('2034-01-05', t), ...opts })).skipped, /06:00–22:00/, t);
  for (const t of ['06:00', '22:00']) assert.ok(Array.isArray((await health.healthCheckJob({ at: local('2034-01-05', t), ...opts })).active), t);
  assert.equal(localTime(local('2034-07-05', '06:00')), '06:00', 'in summer time too');
  let calls = 0;
  const counted = async () => { calls++; return { ok: false, detail: 'not signed in' }; };
  await exclusive('ingest:sync', () => health.checkHealth({ at: local('2034-01-06', '10:07'), authCheck: counted, host: HOST, uptimeHours: 1 }));
  assert.equal(calls, 0, 'not while an ingest runs');
  await health.checkHealth({ at: local('2034-01-06', '10:22'), authCheck: counted, host: HOST, uptimeHours: 1 });
  assert.equal(calls, 1);
});

test('/api/health reports jobs, sign-in, pending pages, spend, memory and disk; at normal, without detail text', async () => {
  run('digest', new Date(Date.now() - 3 * 3600e3), new Date(Date.now() - 3 * 3600e3 + 60e3), 1);
  run('ingest:sync', new Date(Date.now() - 2 * 3600e3), new Date(Date.now() - 2 * 3600e3 + 60e3), 0, 'Error: MARKER-LUNA page failed');
  run('ingest:sync', new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3 + 60e3), 0, 'Error: MARKER-LUNA page failed again');
  db.prepare(`INSERT INTO documents (id, name) VALUES ('d1', 'Field notes')`).run();
  db.prepare(`INSERT INTO pages (id, doc_id, page_index, status, tags) VALUES ('p1', 'd1', 0, 'rendered', '[]'), ('p2', 'd1', 1, 'error', '[]')`).run();
  await health.checkHealth({ authCheck: signedOut, host: HOST, uptimeHours: 1 });

  const res = await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${all}` } });
  const h = await res.json();
  assert.equal(res.status, 200);
  assert.equal(h.ok, false);
  assert.deepEqual(h.alerts.map((a) => a.condition).sort(), ['runs_failed', 'source_auth']);
  assert.match(JSON.stringify(h.alerts), /MARKER-LUNA/, 'an "all" client gets the detail');
  assert.deepEqual([h.jobs.digest.last_run.ok, h.jobs.sync.last_run.ok, h.jobs.sync.last_success], [true, false, null]);
  assert.ok(h.jobs.digest.hours_since_success >= 2.9 && h.jobs.digest.hours_since_success <= 3.1);
  assert.deepEqual([h.source.adapter, h.source.auth.ok], ['fixture', false]);
  assert.deepEqual(h.pages_pending, { rendered: 1, queued: 0, error: 1 });
  for (const k of ['last_24h', 'last_30d']) assert.equal(typeof h.usage[k].usd, 'number');
  assert.equal(typeof h.disk.free_gb, 'number');
  assert.equal(h.registry.loaded, true);

  const n = await (await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${normal}` } })).text();
  assert.doesNotMatch(n, /MARKER-LUNA|moonbase/i);
  const nh = JSON.parse(n);
  assert.deepEqual(nh.alerts.map((a) => Object.keys(a).sort()), [['condition', 'last_sent', 'since'], ['condition', 'last_sent', 'since']]);
  assert.deepEqual(Object.keys(nh.source.auth).sort(), ['checked_at', 'ok']);
  assert.deepEqual(Object.keys(nh.registry).sort(), ['errors', 'loaded', 'source', 'version', 'warnings']);
});
