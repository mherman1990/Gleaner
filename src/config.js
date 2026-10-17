// Config: defaults ← /data/config.json ← environment. Env wins so Umbrel/compose can override.
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.GLEANER_DATA_DIR || '/data';

// Secrets live in /data/gleaner.env (KEY=value lines) so Umbrel's compose file stays secret-free.
const ENV_FILE = path.join(DATA_DIR, 'gleaner.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const defaults = {
  dataDir: DATA_DIR,
  timezone: 'America/Chicago',
  source: {
    adapter: 'rmapi',            // rmapi | ssh | fixture
    folder: '/Daily',            // only this tablet folder is ever read
    rmapiBin: 'rmapi',
    rmapiConfig: path.join(DATA_DIR, 'secrets', 'rmapi.conf'),
    sshHost: '10.11.99.1',       // USB default; set to the tablet's Wi-Fi IP for LAN
    sshUser: 'root',
    sshKey: path.join(DATA_DIR, 'secrets', 'id_ed25519'),
    fixtureDir: './fixtures',
  },
  llm: {
    mode: 'live',                         // live | mock
    transcribeModel: 'claude-sonnet-5-5', // handwriting accuracy matters → Sonnet
    triageModel: 'claude-haiku-5-5',      // cross-page dedupe
    digestModel: 'claude-sonnet-5-5',     // daily plan synthesis
    weeklyModel: 'claude-opus-5-5',       // Sunday review (flagship)
    useBatch: true,                       // nightly transcription goes through the Batch API
    batchPollSeconds: 60,
    batchMaxWaitMinutes: 180,             // after this, unfinished pages fall back to sync calls
    maxLongEdgePx: 1568,
  },
  schedule: {
    ingestNightly: '30 21 * * *',        // 9:30pm daily — batch, cheap
    ingestMorning: '15 6 * * 1-5',       // 6:15am weekdays — sync top-up for late pages
    morningDigest: '30 6 * * 1-5',       // 6:30am weekdays — digest + Today sheet + push
    reminderSweep: '*/30 7-18 * * 1-5',  // due/overdue nudges during working hours
    weeklyReview: '0 18 * * 0',          // Sunday 6pm
  },
  reminders: {
    staleDays: 7,     // open loop with no mention in N days → called out in weekly review
    carryFlagAt: 3,   // rewritten on N separate days → "you keep carrying this"
    maxNudgesPerItem: 3,
  },
  notify: {
    teamsWebhookUrl: '',        // Power Automate "When a Teams webhook request is received"
    ntfyUrl: '',                // e.g. http://umbrel.local:8090/gleaner
    tabletTodaySheet: true,     // push a Today PDF back to the tablet each morning
    tabletTodayFolder: '/Daily',
    tabletTodayName: '_Today',
  },
  server: { port: 3717, apiToken: '' }, // /api requires this Bearer token and is disabled while it's empty
  tags: [
    // Seed vocabulary — edit in /data/config.json. The model maps circled words / #tags onto these.
    '45Z', 'RFS', 'SRE', 'CoverCress', 'PULA', 'FIFRA', 'farm-bill', 'China-trade', 'Brazil',
    'right-to-repair', 'farm-truck', 'IWILL', 'water-quality', 'crop-insurance', 'checkoff-value',
    'LCA-coproduct', 'Friday-Memo', 'BeanBrief', 'Granary', 'Market-Intel', 'polibrief',
    'IBC', 'farm', 'personal',
  ],
};

function deepMerge(a, b) {
  if (b === undefined || b === null) return a;
  if (typeof b !== 'object' || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = a && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  }
  return out;
}

function fromFile() {
  const p = path.join(DATA_DIR, 'config.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`[config] ${p} is not valid JSON: ${e.message}`); return {}; }
}

function fromEnv() {
  const e = process.env, o = {};
  const set = (keys, val) => {
    if (val === undefined || val === '') return;
    let t = o;
    for (const k of keys.slice(0, -1)) t = t[k] ??= {};
    t[keys.at(-1)] = val;
  };
  set(['timezone'], e.TZ);
  set(['source', 'adapter'], e.GLEANER_SOURCE);
  set(['source', 'folder'], e.GLEANER_FOLDER);
  set(['source', 'sshHost'], e.GLEANER_SSH_HOST);
  set(['source', 'fixtureDir'], e.GLEANER_FIXTURE_DIR);
  set(['llm', 'mode'], e.GLEANER_LLM);
  if (e.GLEANER_USE_BATCH) set(['llm', 'useBatch'], e.GLEANER_USE_BATCH === 'true');
  set(['notify', 'teamsWebhookUrl'], e.GLEANER_TEAMS_WEBHOOK);
  set(['notify', 'ntfyUrl'], e.GLEANER_NTFY_URL);
  if (e.GLEANER_TABLET_SHEET) set(['notify', 'tabletTodaySheet'], e.GLEANER_TABLET_SHEET === 'true');
  set(['server', 'apiToken'], e.GLEANER_API_TOKEN);
  if (e.GLEANER_PORT) set(['server', 'port'], Number(e.GLEANER_PORT));
  return o;
}

export const config = deepMerge(deepMerge(defaults, fromFile()), fromEnv());

export const paths = {
  db: path.join(config.dataDir, 'gleaner.db'),
  raw: path.join(config.dataDir, 'raw'),         // pulled document bundles
  renders: path.join(config.dataDir, 'renders'), // page PNGs
  notes: path.join(config.dataDir, 'notes'),     // markdown system of record
  out: path.join(config.dataDir, 'out'),         // digests, Today PDF
  secrets: path.join(config.dataDir, 'secrets'),
};
for (const [k, p] of Object.entries(paths)) if (k !== 'db') fs.mkdirSync(p, { recursive: true });

/** Today's date (YYYY-MM-DD) in the configured timezone, not UTC. */
export function localDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function localWeekday(d = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'long' }).format(d);
}
