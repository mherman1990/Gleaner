// Health (spec §1.6): GET /api/health, and a check every 15 minutes from 6:00am to 10:00pm (at :07, :22, :37 and :52,
// clear of the minutes the ingests and the digest start, since they use rmapi too) that alerts through the notify
// adapter. Deterministic, no LLM. Conditions (each alerted at most once per health.alertEveryHours, and an
// alert counts only once a channel accepted it, as for nudges, so with no channel set up nothing is used up):
//   batch_late   last night's batch run is still going, failed, or never ran (checked from 6:00am)
//   source_auth  the source adapter's authCheck() failed (rmapi: a lapsed reMarkable sign-in)
//   runs_failed  the last two runs both failed
//   memory       MemAvailable under health.memAvailableMinMB, or swap more than health.swapMaxPct full
//   disk         less than health.diskMinGB free on the data folder
//   spend        24 h spend over health.spendFactor × the 30-day daily average, and over health.spendFloorUsd
// The state is the alerts table (migration 006), so the service and a `docker exec … cli.js health --check` agree.
import fs from 'node:fs';
import { config, localDate, localTime } from './config.js';
import { db } from './db.js';
import { source } from './adapters/index.js';
import { notify } from './notify/index.js';
import { registryStatus } from './registry.js';
import { doctor as inboxDoctor } from './adapters/api-inbox.js';
import { busy } from './jobs.js';

const HOUR = 3600e3;
export const JOBS = { batch: 'ingest:batch', sync: 'ingest:sync', digest: 'digest' };
/** How far config.timezone's clock is ahead of UTC at instant t, in ms (negative in the Americas). */
function tzOffset(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(t).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
/** The instant it's 6:00am local time on at's local day. Twice, so a clock change overnight is taken into account. */
export function sixAm(at) {
  const wall = Date.parse(`${localDate(at)}T06:00:00Z`);
  const first = wall - tzOffset(new Date(wall));
  return new Date(wall - tzOffset(new Date(first)));
}
const firstLine = (s) => String(s ?? '').trim().split('\n')[0].slice(0, 200);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** MemAvailable and swap from /proc/meminfo's text. null when the fields aren't there. */
export function parseMeminfo(text) {
  const kb = (name) => { const m = String(text).match(new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm')); return m ? Number(m[1]) : null; };
  const avail = kb('MemAvailable'), swapTotal = kb('SwapTotal'), swapFree = kb('SwapFree');
  if (avail === null) return null;
  return {
    available_mb: Math.round(avail / 1024),
    swap_total_mb: swapTotal === null ? null : Math.round(swapTotal / 1024),
    swap_used_pct: swapTotal ? round(((swapTotal - (swapFree ?? swapTotal)) / swapTotal) * 100, 1) : 0,
  };
}

/** Memory (Linux only; null elsewhere) and free space on the data folder. */
export function readHost() {
  let memory = null, disk = null;
  try { memory = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8')); } catch { /* not Linux */ }
  try { const s = fs.statfsSync(config.dataDir); disk = { path: config.dataDir, free_gb: round((s.bavail * s.bsize) / 1024 ** 3) }; } catch { /* unreadable */ }
  return { memory, disk };
}

/** The price per million tokens for a model id: its family's (by prefix), or the dearest listed. */
export function priceOf(model) {
  const models = config.prices.models;
  const key = Object.keys(models).filter((k) => String(model ?? '').startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (key) return models[key];
  return Object.values(models).reduce((a, b) => (b.input + b.output > a.input + a.output ? b : a));
}

/** Tokens and estimated US dollars logged in usage from `from` up to `to` (Dates). */
export function spend(from, to) {
  const rows = db.prepare(`SELECT model, batch, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
    SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write FROM usage WHERE at >= ? AND at < ? GROUP BY model, batch`)
    .all(from.toISOString(), to.toISOString());
  const out = { usd: 0, calls: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0 };
  for (const r of rows) {
    const p = priceOf(r.model);
    const usd = ((r.input ?? 0) * p.input + (r.output ?? 0) * p.output + (r.cache_read ?? 0) * (p.cacheRead ?? p.input)
      + (r.cache_write ?? 0) * p.input * config.prices.cacheWriteFactor) / 1e6;
    out.usd += r.batch ? usd * config.prices.batchFactor : usd;
    out.calls += r.calls;
    out.input_tokens += r.input ?? 0;
    out.output_tokens += r.output ?? 0;
    out.cache_read += r.cache_read ?? 0;
    out.cache_write += r.cache_write ?? 0;
  }
  out.usd = round(out.usd, 4);
  return out;
}

/** For each job: its last run (still running when ended_at is null), and when it last succeeded. */
export function jobStatus(at = new Date()) {
  return Object.fromEntries(Object.entries(JOBS).map(([name, kind]) => {
    const last = db.prepare('SELECT started_at, ended_at, ok FROM runs WHERE kind=? ORDER BY id DESC LIMIT 1').get(kind);
    const good = db.prepare('SELECT ended_at FROM runs WHERE kind=? AND ok=1 ORDER BY id DESC LIMIT 1').get(kind);
    return [name, {
      last_run: last ? { started_at: last.started_at, ended_at: last.ended_at, ok: last.ended_at ? !!last.ok : null } : null,
      last_success: good?.ended_at ?? null,
      hours_since_success: good ? round((at - Date.parse(good.ended_at)) / HOUR, 1) : null,
    }];
  }));
}

/**
 * Each condition as read now: { condition, active, detail }. auth is the adapter's authCheck() answer (undefined: the
 * adapter has none, so it isn't checked); host is readHost()'s; uptimeHours is how long this process has run, so a
 * service started after last night's batch time doesn't call it missing.
 */
export function evaluate({ at = new Date(), auth, host = readHost(), uptimeHours = process.uptime() / 3600 } = {}) {
  const h = config.health;
  const out = [];
  const add = (condition, active, detail) => out.push({ condition, active: !!active, detail });

  // Last night's batch: the latest batch run that started in the 24 hours before 6:00am today. Tonight's (from
  // 9:30pm) isn't judged until tomorrow.
  const six = sixAm(at);
  if (config.schedule.ingestNightly && at >= six) {
    const last = db.prepare(`SELECT started_at, ended_at, ok, detail FROM runs WHERE kind=? AND started_at >= ? AND started_at < ?
      ORDER BY id DESC LIMIT 1`).get(JOBS.batch, new Date(six - 24 * HOUR).toISOString(), six.toISOString());
    if (last?.ended_at && last.ok) add('batch_late', false, `finished at ${localTime(new Date(last.ended_at))}`);
    else if (last?.ended_at) add('batch_late', true, `last night's batch failed: ${firstLine(last.detail)}`);
    else if (last) add('batch_late', true, `last night's batch is still running (started ${localTime(new Date(last.started_at))})`);
    else add('batch_late', uptimeHours >= 24, 'no nightly batch run in the last 24 hours');
  }

  if (auth) add('source_auth', !auth.ok, `${config.source.adapter}: ${auth.detail}`);

  const [a, b] = db.prepare('SELECT kind, started_at, ended_at, ok, detail FROM runs WHERE ended_at IS NOT NULL ORDER BY id DESC LIMIT 2').all();
  const both = a && b && !a.ok && !b.ok;
  add('runs_failed', both, both ? [a, b].map((r) => `${r.kind} at ${localTime(new Date(r.started_at))}: ${firstLine(r.detail)}`).join('; ')
    : 'the last two runs didn\'t both fail');

  if (host.memory) {
    const { available_mb: mb, swap_used_pct: swap } = host.memory;
    const low = mb < h.memAvailableMinMB, swapping = swap > h.swapMaxPct;
    add('memory', low || swapping, `${mb} MB available (alert under ${h.memAvailableMinMB}), swap ${swap}% used (alert over ${h.swapMaxPct}%)`);
  }
  if (host.disk) add('disk', host.disk.free_gb < h.diskMinGB, `${host.disk.free_gb} GB free on ${host.disk.path} (alert under ${h.diskMinGB} GB)`);

  const day = spend(new Date(at - 24 * HOUR), at).usd;
  const avg = spend(new Date(at - 30 * 24 * HOUR), at).usd / 30;
  add('spend', day > Math.max(h.spendFactor * avg, h.spendFloorUsd),
    `$${day.toFixed(2)} in the last 24 h; 30-day average $${avg.toFixed(2)} a day (alert over ${h.spendFactor}× and $${h.spendFloorUsd.toFixed(2)})`);
  return out;
}

const TITLES = {
  batch_late: 'Last night\'s batch didn\'t finish',
  source_auth: 'Can\'t reach the tablet\'s notes',
  runs_failed: 'Two runs in a row failed',
  memory: 'The Pi is short of memory',
  disk: 'The Pi is short of disk space',
  spend: 'API spend spiked',
};
const HINTS = {
  source_auth: 'For rmapi, sign in again: see the README (rmapi registration).',
  runs_failed: 'Details: docker logs herman-gleaner_web_1, or /api/status.',
};

/**
 * One health check: read every condition, record it in alerts, and send one alert listing the conditions that hold
 * and haven't reached a channel in the last health.alertEveryHours. authCheck and send are injectable for tests.
 * The sign-in isn't checked while an ingest runs: two rmapi processes can both renew its token and write its config
 * at once, and a failing sign-in fails the ingest anyway. It keeps its last reading until the next check.
 */
export async function checkHealth({ at = new Date(), authCheck = source().authCheck, host = readHost(), send = notify,
  uptimeHours = process.uptime() / 3600 } = {}) {
  const auth = authCheck && !busy() ? await authCheck().catch((e) => ({ ok: false, detail: e.message })) : undefined;
  const readings = evaluate({ at, auth, host, uptimeHours });
  const iso = at.toISOString();
  const due = db.transaction(() => readings.filter((r) => {
    const cur = db.prepare('SELECT * FROM alerts WHERE condition=?').get(r.condition);
    db.prepare(`INSERT INTO alerts (condition, active, first_seen, checked_at, detail) VALUES (@condition, @active, @first, @iso, @detail)
      ON CONFLICT(condition) DO UPDATE SET active=@active, first_seen=@first, checked_at=@iso, detail=@detail`)
      .run({ ...r, active: r.active ? 1 : 0, first: r.active ? (cur?.active ? cur.first_seen : iso) : null, iso });
    return r.active && (!cur?.last_sent || at - Date.parse(cur.last_sent) >= config.health.alertEveryHours * HOUR);
  })).immediate();
  const active = readings.filter((r) => r.active).map((r) => r.condition);
  if (!due.length) return { active, sent: [] };
  const channels = await send({
    title: due.length === 1 ? `Gleaner: ${TITLES[due[0].condition]}` : `Gleaner: ${due.length} problems`,
    body: due.map((r) => [`${TITLES[r.condition]}: ${r.detail}`, HINTS[r.condition]].filter(Boolean).join(' ')).join('\n'),
    priority: 'high',
  });
  if (!Object.values(channels).includes('ok')) return { active, sent: [], due: due.map((r) => r.condition), channels };
  const mark = db.prepare('UPDATE alerts SET last_sent=? WHERE condition=?');
  db.transaction(() => due.forEach((r) => mark.run(iso, r.condition)))();
  return { active, sent: due.map((r) => r.condition), channels };
}

/** The scheduled job. Checks run from 6:00am to 10:00pm, whatever schedule.healthCheck is set to. */
export async function healthCheckJob({ at = new Date(), ...opts } = {}) {
  const t = localTime(at);
  if (t < '06:00' || t > '22:00') return { skipped: `checks run 06:00–22:00, it's ${t}` };
  return checkHealth({ at, ...opts });
}

/**
 * GET /api/health. Live: memory, disk, the jobs' runs, pending pages and spend. From the last check: the source's
 * sign-in and the alerts. At sensitivity normal, pages are counted only if the client may see them, and no detail
 * text (run errors, registry errors, alert readings) is given.
 */
export function healthReport(vis, { at = new Date(), host = readHost() } = {}) {
  const pending = {};
  for (const p of db.prepare(`SELECT id, tags, status FROM pages WHERE status IN ('rendered', 'queued', 'error')`).all().filter(vis.page)) {
    pending[p.status] = (pending[p.status] ?? 0) + 1;
  }
  const alerts = db.prepare('SELECT * FROM alerts').all();
  const auth = alerts.find((a) => a.condition === 'source_auth');
  const last30 = spend(new Date(at - 30 * 24 * HOUR), at);
  const reg = registryStatus();
  const inbox = inboxDoctor();
  return {
    ok: !alerts.some((a) => a.active),
    checked_at: alerts.reduce((m, a) => (a.checked_at > (m ?? '') ? a.checked_at : m), null),
    alerts: alerts.filter((a) => a.active).map((a) => ({ condition: a.condition, since: a.first_seen, last_sent: a.last_sent,
      ...(vis.all ? { detail: a.detail } : {}) })),
    jobs: jobStatus(at),
    source: { adapter: config.source.adapter, auth: auth ? { ok: !auth.active, checked_at: auth.checked_at, ...(vis.all ? { detail: auth.detail } : {}) } : null },
    pages_pending: { rendered: pending.rendered ?? 0, queued: pending.queued ?? 0, error: pending.error ?? 0 },
    usage: { last_24h: spend(new Date(at - 24 * HOUR), at), last_30d: last30, daily_avg_30d_usd: round(last30.usd / 30, 4) },
    memory: host.memory,
    disk: host.disk,
    registry: vis.all ? reg : { loaded: reg.loaded, source: reg.source, version: reg.version, errors: reg.errors?.length ?? 0, warnings: reg.warnings.length },
    inbox: vis.all ? inbox : Object.fromEntries(Object.entries(inbox).filter(([k]) => k !== 'lastError')),
  };
}
