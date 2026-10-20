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
    ingestDaytime: '0 8-16/2 * * 1-5',   // 8, 10, 12, 2, 4 on weekdays — sync, so the day's writing shows up the same day
    morningDigest: '30 6 * * 1-5',       // 6:30am weekdays — digest + Today sheet + push
    reminderSweep: '*/30 7-18 * * 1-5',  // due/overdue nudges during working hours
    weeklyReview: '0 18 * * 0',          // Sunday 6pm
  },
  reminders: {
    staleDays: 7,     // open loop with no mention in N days → called out in weekly review
    carryFlagAt: 3,   // rewritten on N separate days → "you keep carrying this"
    maxNudgesPerItem: 3,
    leadMinutes: 30,  // an item due at a time is nudged on the first sweep within this many minutes of it
  },
  notify: {
    teamsWebhookUrl: '',        // Power Automate "When a Teams webhook request is received"
    ntfyUrl: '',                // e.g. http://umbrel.local:8090/gleaner
    tabletTodaySheet: true,     // push a Today PDF back to the tablet each morning
    tabletTodayFolder: '/Daily',
    tabletTodayName: '_Today',
  },
  notebooks: {
    // Notebooks where every written line is a to-do, marked or not. Matched by name, ignoring case.
    // Every other notebook needs the notation (☐, →, !, dates…) for a line to become an item.
    taskLists: ['To do'],
  },
  // The project registry: canonical tags, aliases, people, sensitivity. Lives on the Pi, never in the repo
  // (see config/projects.example.yaml). Without it, the flat `tags` list below seeds the transcriber.
  registry: { path: path.join(DATA_DIR, 'projects.yaml') },
  // Per-client API tokens (hashes only); see src/auth.js. apiToken is the legacy single token (client "legacy").
  auth: { tokensPath: path.join(DATA_DIR, 'tokens.json') },
  // POST /api/items waits this long for the item to be applied (the dedupe call included), then answers "queued" and
  // finishes in the background; a request that failed is retried at the next ingest.
  api: { createBudgetSeconds: 15 },
  server: { port: 3717, apiToken: '' }, // /api is disabled while there's no token in tokens.json and this is empty
  tags: [
    // Seed vocabulary, used only while no project registry is loaded. Edit in /data/config.json.
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
  set(['registry', 'path'], e.GLEANER_REGISTRY);
  set(['auth', 'tokensPath'], e.GLEANER_TOKENS);
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

/** Whether a notebook is listed in notebooks.taskLists (every line is a to-do). Case and outer spaces don't matter. */
export function isTaskList(notebookName) {
  const name = String(notebookName ?? '').trim().toLowerCase();
  return config.notebooks.taskLists.some((t) => String(t).trim().toLowerCase() === name);
}

/** Today's date (YYYY-MM-DD) in the configured timezone, not UTC. */
export function localDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function localWeekday(d = new Date()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'long' }).format(d);
}
/** The time of day (HH:MM, 24-hour) in the configured timezone. */
export function localTime(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/** "14:05", "9:30", "2pm", "2:30 PM" → "HH:MM" (24-hour). Anything else, a bare "14" included, → null. */
export function normTime(s) {
  const m = String(s ?? '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?$|^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let h = Number(m[1] ?? m[4]);
  const min = Number(m[2] ?? m[5] ?? 0);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === 'p' ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** "14:00" → "2pm", "09:30" → "9:30am", for display. */
export function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}
