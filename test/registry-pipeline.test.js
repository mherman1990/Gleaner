// Spec step 1 acceptance, end to end through the real SDK against a fake Anthropic API:
//   - a page with two different aliases of one project stores the canonical tag, and an unknown tag is flagged
//     (the spec's example uses real aliases; this public repo uses invented ones: #wr and #gizmo for widget-report);
//   - a second run with an unchanged registry reads the system prompt from the cache;
//   - changing the registry changes the prompt (a cache miss) and the canonical tags.
// All page content and registry entries are invented.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempEnv, rendererMissing, FIXTURES } from './helpers.js';
import { fakeAnthropic } from './fakes/anthropic.js';

const skip = rendererMissing;
const REGISTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'registry.yaml');
let pageDate; // yesterday, local: always inside the weekly review's 7-day window

// What the "model" reads on the one page: two aliases with a case variant, an unknown tag on both items, a known
// short name, and a first name two registry people share, which Gleaner flags itself.
function page(params) {
  const userText = params.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const prior = new Map([...userText.matchAll(/id=(\S+): (.+) \[\w+\]$/gm)].map((m) => [m[2], m[1]]));
  const item = (text, extra) => ({ existing_item_id: prior.get(text) ?? null, text, kind: 'followup', assignee: null,
    due: null, due_time: null, priority: false, status: 'open', ...extra });
  return {
    page_date: pageDate, summary: 'Invented notes on the widget report', tags: ['#WR', 'Gizmo', 'mystery-tag'],
    transcription_md: '- → Pat: send the #wr draft\n- Ask Alex about the #gizmo numbers #mystery-tag', legibility: 'high', uncertain_spans: [],
    items: [
      item('Send Pat the widget report draft', { person: 'Pat', tags: ['#wr', 'mystery-tag'] }),
      item('Ask Alex about the widget numbers', { person: 'Alex', tags: ['gizmo', 'mystery-tag', 'Mystery-Tag'] }),
    ],
    closes: [],
  };
}

const fake = await fakeAnthropic((params, purpose) =>
  purpose === 'transcribe' ? page(params) : purpose === 'dedupe' ? { matches: [] } : 'Invented weekly review text.');
const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'gleaner-fx-'));
fs.cpSync(path.join(FIXTURES, 'Calls'), path.join(fx, 'Calls'), { recursive: true });
const dataDir = tempEnv('regpipe', {
  GLEANER_LLM: 'live', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: fake.url, GLEANER_FIXTURE_DIR: fx, GLEANER_PORT: '0',
});
fs.copyFileSync(REGISTRY, path.join(dataDir, 'projects.yaml'));

const { localDate } = await import('../src/config.js');
const { db, P } = await import('../src/db.js');
const { ingest, markForRetranscription } = await import('../src/pipeline/ingest.js');
const { registryStatus, unregisteredTags, personAmbiguous } = await import('../src/registry.js');
const { weeklyReview, addDays } = await import('../src/digest/digest.js');
const { startServer } = await import('../src/server.js');
pageDate = addDays(localDate(), -1);

const items = () => db.prepare('SELECT * FROM items ORDER BY code').all();
const lastTranscribeUsage = () => db.prepare(`SELECT * FROM usage WHERE purpose='transcribe' ORDER BY id DESC LIMIT 1`).get();
const lastRunDetail = () => JSON.parse(db.prepare(`SELECT detail FROM runs WHERE kind LIKE 'ingest%' ORDER BY id DESC LIMIT 1`).get().detail);

test('two aliases of one project (#wr, #gizmo) resolve to widget-report; an unknown tag is kept and flagged', { skip }, async () => {
  const r = await ingest({ mode: 'sync' });
  assert.equal(r.failed, 0);
  assert.equal(r.created, 2);
  const call = fake.requests.find((q) => q.purpose === 'transcribe').params;
  assert.ok(call.output_config.format.schema.properties.items, 'the real SDK request reached the fake API');
  assert.match(call.system[0].text, /^- widget-report: Widget emissions report \(also written: wr, gizmo, sprocket-study\)$/m);
  const [a, b] = items();
  assert.deepEqual(P(a.tags), ['widget-report', 'mystery-tag']);
  assert.deepEqual(P(b.tags), ['widget-report', 'mystery-tag'], 'case variants of the unknown tag are stored once');
  assert.deepEqual(unregisteredTags(P(b.tags)), ['mystery-tag']);
  assert.deepEqual(P(db.prepare('SELECT tags FROM pages').get().tags), ['widget-report', 'mystery-tag']);
  assert.deepEqual([a.person, personAmbiguous(a)], ['Pat Example', false], 'a write_as name becomes the full name');
  assert.deepEqual([b.person, personAmbiguous(b)], ['Alex', true], 'a shared first name stays as written and is flagged');
  assert.equal(lastRunDetail().registry, registryStatus().version, 'the run records the registry version');
});

test('a second run with an unchanged registry reads the system prompt from the cache', { skip }, async () => {
  const first = lastTranscribeUsage();
  assert.equal(first.cache_read, 0);
  assert.ok(first.cache_write > 0, 'the static prompt is long enough to cache');
  markForRetranscription('all');
  const r = await ingest({ mode: 'sync' });
  assert.equal(r.pages, 1);
  assert.equal(r.created, 0, 're-read in place, no duplicates');
  assert.ok(lastTranscribeUsage().cache_read > 0);
});

test('the API shows the flags, filters by alias or unknown tag in any case, and edits person; the weekly review lists the tag', { skip }, async (t) => {
  const server = startServer();
  await new Promise((r) => server.once('listening', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/ui/api/items`;
  const get = async (q) => (await fetch(`${url}${q}`)).json();
  const b = (await get('')).find((i) => i.person === 'Alex');
  assert.deepEqual([b.unregistered_tags, b.person_ambiguous], [['mystery-tag'], true]);
  assert.equal((await get('?tag=SPROCKET-STUDY')).length, 2, 'an alias filters like its canonical tag');
  assert.equal((await get('?tag=%23MYSTERY-TAG')).length, 2, 'an unknown tag matches in any case');

  const w = await weeklyReview({ push: false });
  assert.match(w.md, /## Unregistered tags[\s\S]*^- #mystery-tag — 2 items, 1 page$/m, 'items and pages counted apart');

  const res = await fetch(`${url}/${b.code}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ person: 'Sam' }) });
  const edited = await res.json();
  assert.deepEqual([res.status, edited.person, edited.person_ambiguous, edited.edited], [200, 'Sam Fixture', false, ['person']]);
});

test('editing the registry changes the prompt (a cache miss) and maps the tag from then on', { skip }, async () => {
  const before = registryStatus().version;
  const file = path.join(dataDir, 'projects.yaml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('aliases: [404, 1.10, 0707, bp]', 'aliases: [404, 1.10, 0707, bp, mystery-tag]'));
  markForRetranscription('all');
  await ingest({ mode: 'sync' });
  assert.notEqual(lastRunDetail().registry, before);
  assert.equal(lastTranscribeUsage().cache_read, 0, 'a new registry means a new static prompt');
  for (const i of items()) assert.deepEqual(P(i.tags), ['widget-report', 'bridge-permit']);
  assert.deepEqual(unregisteredTags(P(items()[1].tags)), []);
  assert.equal(items()[1].person, 'Sam Fixture', "the previous test's hand edit outlasts this re-read, which says Alex");
});

after(() => { db.close(); fake.close(); });
