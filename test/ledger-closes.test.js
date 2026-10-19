// A page that closed or snoozed items from other pages (by number, "✓1" / "3 → Fri", or by ticking a line for them)
// is read again. The prompt doesn't list those items, so the model can't read a close mark back as the item's line.
// A ticked line with the words of a done item of the page is that item read again, matched in code (so this week's open
// copy of a recurring task isn't closed in its place) and changing nothing; a done task written again unticked is a new
// item; and the dedupe offers done items only to ticked lines, labelled as closed. Real SDK against the fake API.
// All content is invented.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempEnv, rendererMissing, FIXTURES } from './helpers.js';
import { fakeAnthropic } from './fakes/anthropic.js';

const userText = (params) => {
  const c = params.messages[0].content;
  return typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
};
// The fake Haiku matches same text (without the [person] label), a ticked line to an OPEN or CLOSED item, any other
// line to an OPEN one; with closest set, it picks the closest wording instead, as a real model might; with every set,
// it lists every close wording, in the order given, whatever its label.
const dedupes = [];
let closest = false, every = false;
function dedupe(params) {
  const text = userText(params);
  dedupes.push(text);
  const words = (t) => new Set(t.toLowerCase().split(/\W+/).filter(Boolean));
  const near = (a, b) => [...words(a)].filter((w) => words(b).has(w)).length / Math.max(words(a).size, words(b).size);
  const news = [...text.matchAll(/^NEW (\S+): (.+?)( \(ticked\))?$/gm)].map((m) => ({ ref: m[1], t: m[2], ticked: !!m[3] }));
  const olds = [...text.matchAll(/^(OPEN|CLOSED|ERASED|OTHER) (\d+): (.+)$/gm)].map((m) => ({ open: m[1] === 'OPEN' || m[1] === 'ERASED', code: Number(m[2]), t: m[3] }));
  return { matches: news.flatMap((n) => {
    if (every) return olds.filter((o) => near(o.t, n.t) > 0.5).map((o) => ({ new_ref: n.ref, code: o.code }));
    const fits = olds.filter((o) => (closest ? near(o.t, n.t) > 0.5 : o.t === n.t));
    const pick = closest ? fits.sort((a, b) => near(b.t, n.t) - near(a.t, n.t))[0] : fits.find((o) => o.open || n.ticked);
    return pick ? [{ new_ref: n.ref, code: pick.code }] : [];
  }) };
}
let transcribe = null; // the ingest test's scripted pages
const fake = await fakeAnthropic((params, purpose) => (purpose === 'dedupe' ? dedupe(params) : transcribe(params)));
const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'gleaner-fx-'));
fs.cpSync(path.join(FIXTURES, 'Daily'), path.join(fx, 'Daily'), { recursive: true });
tempEnv('ledger-closes', { GLEANER_LLM: 'live', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: fake.url, GLEANER_FIXTURE_DIR: fx });

const { db } = await import('../src/db.js');
const { applyPageResult } = await import('../src/pipeline/ledger.js');
const { ingest, markForRetranscription } = await import('../src/pipeline/ingest.js');
after(() => { db.close(); fake.close(); });

let n = 0;
function newPage() {
  const id = `pg${++n}`;
  db.prepare('INSERT OR IGNORE INTO documents (id, name) VALUES (?, ?)').run('doc1', 'Field notes');
  db.prepare(`INSERT INTO pages (id, doc_id, page_index, rm_hash, status) VALUES (?,?,?,?, 'rendered')`).run(id, 'doc1', n, `hash${n}`);
  return db.prepare('SELECT * FROM pages WHERE id=?').get(id);
}
const line = (text, extra = {}) => ({ existing_item_id: null, text, kind: 'action', status: 'open', person: null, assignee: null,
  due: null, due_time: null, priority: false, tags: [], ...extra });
const read = (p, date, items, closes = []) => applyPageResult(p, { page_date: date, summary: 's', tags: [], transcription_md: 'md',
  legibility: 'high', uncertain_spans: [], items, closes }, date);
const row = (text) => db.prepare('SELECT id, code, status, tags, due, carry_days, snooze_until FROM items WHERE text=? ORDER BY code').get(text);
const mentionsOn = (p) => db.prepare('SELECT item_id FROM item_mentions WHERE page_id=?').all(p.id).map((m) => m.item_id);
const eventsSince = (id) => db.prepare('SELECT item_code, field FROM events WHERE id > ?').all(id);
const lastEvent = () => db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM events').get().n;

test('a ticked line read again for an item the page closed changes nothing; a done task written again is new', async () => {
  const a = newPage();
  await read(a, '2026-10-13', [line('Order the invented seed', { tags: ['orchard'], due: '2026-10-15' }), line('Call Tom about the invented letter'),
    line('Sign the invented lease')]);
  const [seed, call] = ['Order the invented seed', 'Call Tom about the invented letter'].map(row);
  const b = newPage();
  await read(b, '2026-10-14', [], [{ code: seed.code, action: 'done', snooze_until: null, evidence: `✓${seed.code}` },
    { code: call.code, action: 'snooze', snooze_until: '2999-01-01', evidence: `${call.code} → Fri` }]);
  const before = row('Order the invented seed');
  const mark = lastEvent();
  // The seed order is written again, unticked, as a new order, next to a ticked new line (so the dedupe is offered
  // the page's done items). The fake Haiku picks the closest wording, the done seed order: the code refuses it.
  closest = true;
  try {
    await read(b, '2026-10-14', [line('Order the invented seed'), line('Sweep the invented barn', { status: 'done' })]);
  } finally { closest = false; }
  assert.deepEqual(db.prepare('SELECT status FROM items WHERE text=? ORDER BY code').all('Order the invented seed').map((i) => i.status), ['done', 'open']);
  // Then the old seed line, ticked, comes back without its id (the prompt never listed it): that close, read again.
  const fresh = db.prepare(`SELECT id FROM items WHERE text='Order the invented seed' AND status='open'`).get().id;
  await read(b, '2026-10-14', [line('Order the invented seed', { existing_item_id: fresh }), line('Order the invented seed', { status: 'done' }),
    line('Sweep the invented barn', { status: 'done', existing_item_id: row('Sweep the invented barn').id })]);
  assert.deepEqual(row('Order the invented seed'), before, 'the done item keeps its tags, due date and carry count');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE text=?').get('Order the invented seed').n, 2);
  assert.ok(!mentionsOn(b).includes(seed.id), 'and has no line on this page');
  assert.deepEqual(eventsSince(mark).map((e) => e.field), ['created', 'created', 'status'], 'only the two new lines (one ticked) change anything');

  // Ticked as dropped this time: still done, as the page closed it.
  await read(b, '2026-10-14', [line('Order the invented seed', { status: 'dropped' })]);
  assert.equal(row('Order the invented seed').status, 'done');
  // A tick on the item this page snoozed closes it.
  await read(b, '2026-10-14', [line('Call Tom about the invented letter', { status: 'done' })]);
  assert.equal(row('Call Tom about the invented letter').status, 'done');
  assert.equal(row('Sign the invented lease').status, 'open', 'an item the page never named is untouched');
});

test('a ticked recurring task read again is its own item, not this week\'s open copy with the same words', async () => {
  const own = newPage(); // last week's page, with the task ticked off on it
  await read(own, '2026-10-06', [line('Send the weekly invented report', { status: 'done' })]);
  const closer = newPage(); // last week's other page, which closed another week's copy by number
  await read(closer, '2026-10-07', [line('Water the invented plants')]);
  await read(newPage(), '2026-10-07', [line('Mail the invented invoices')]);
  const invoices = row('Mail the invented invoices');
  await read(closer, '2026-10-07', [line('Water the invented plants', { existing_item_id: row('Water the invented plants').id })],
    [{ code: invoices.code, action: 'done', snooze_until: null, evidence: `✓${invoices.code}` }]);
  await read(newPage(), '2026-10-13', [line('Send the weekly invented report'), line('Mail the invented invoices')]); // this week's, open
  const thisWeek = db.prepare(`SELECT id, text FROM items WHERE status='open' AND text IN ('Send the weekly invented report', 'Mail the invented invoices')`).all();
  assert.equal(thisWeek.length, 2);

  dedupes.length = 0; // read again, the lines come back without ids, in other case and punctuation
  await read(own, '2026-10-06', [line('send the weekly invented report.', { status: 'done' })]);
  await read(closer, '2026-10-07', [line('Water the invented plants', { existing_item_id: row('Water the invented plants').id }),
    line('Mail the invented invoices!', { status: 'done' })]);
  assert.deepEqual(thisWeek.map((i) => db.prepare('SELECT status FROM items WHERE id=?').get(i.id).status), ['open', 'open']);
  assert.deepEqual(dedupes, [], 'matched in code, before any dedupe call');
});

test('a ticked line is matched in code to a done item only for the same person, or none named', async () => {
  const p = newPage();
  await read(p, '2026-10-20', [line('Send the invented invoice', { person: 'Alex', status: 'done' })]);
  const alex = db.prepare(`SELECT id FROM items WHERE text='Send the invented invoice'`).get().id;
  await read(p, '2026-10-20', [line('Send the invented invoice', { person: 'Alex', status: 'done', existing_item_id: alex }),
    line('Send the invented invoice', { person: 'Jen', status: 'done' })]); // Jen's, ticked, new
  assert.deepEqual(db.prepare(`SELECT person, status FROM items WHERE text='Send the invented invoice' ORDER BY code`).all(),
    [{ person: 'Alex', status: 'done' }, { person: 'Jen', status: 'done' }]);
  const jen = db.prepare(`SELECT id FROM items WHERE person='Jen'`).get().id;
  dedupes.length = 0;
  await read(p, '2026-10-20', [line('Send the invented invoice', { person: 'Alex', status: 'done', existing_item_id: alex }),
    line('Send the invented invoice', { status: 'done' })]); // Jen's line read again, without its id or her name
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM items WHERE text='Send the invented invoice'`).get().n, 2);
  assert.ok(mentionsOn(p).includes(jen) && dedupes.length === 0, 'matched in code, to the one not already linked');

  // A page that closed Alex's by number: Jen's ticked line of the same words there is hers, not his tick.
  const q = newPage();
  await read(q, '2026-10-21', [], [{ code: db.prepare('SELECT code FROM items WHERE id=?').get(alex).code, action: 'done', snooze_until: null, evidence: '✓' }]);
  await read(q, '2026-10-21', [line('Send the invented invoice', { person: 'Jen Two', status: 'done' })]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM items WHERE text='Send the invented invoice'`).get().n, 3, 'a new done item for her');
});

test('a snoozed item elsewhere is offered only to a ticked line: written again unticked, it\'s a new item', async () => {
  await read(newPage(), '2026-10-22', [line('Call the invented lab')]);
  db.prepare(`UPDATE items SET status='snoozed', snooze_until='2999-01-01' WHERE text='Call the invented lab'`).run();
  // A ticked line elsewhere on the page puts the snoozed item in the list; the fake Haiku, picking the closest
  // wording, offers it for the unticked line too, and the code refuses.
  closest = true;
  try {
    await read(newPage(), '2026-10-23', [line('Call the invented lab'), line('Sweep the invented loft', { status: 'done' })]);
  } finally { closest = false; }
  assert.deepEqual(db.prepare(`SELECT status FROM items WHERE text='Call the invented lab' ORDER BY code`).all().map((i) => i.status), ['snoozed', 'open']);
});

test('the dedupe offers done items only to a ticked line, labelled closed', async () => {
  const a = newPage();
  await read(a, '2026-10-15', [line('File the monthly invented tally'), line('Return the invented ladder')]);
  const [old, ladder] = ['File the monthly invented tally', 'Return the invented ladder'].map(row);
  const b = newPage(); // closes last month's report by number and ticks off the ladder's line
  await read(b, '2026-10-15', [line('Fold the invented flyers')], [{ code: old.code, action: 'done', snooze_until: null, evidence: `✓${old.code}` },
    { code: ladder.code, action: 'done', snooze_until: null, evidence: '☑' }]);
  const flyers = row('Fold the invented flyers');
  await read(newPage(), '2026-10-16', [line('File this month\'s monthly invented tally')]); // this month's, open
  const thisMonth = row('File this month\'s monthly invented tally');

  // On b, the recurring task is written again, unticked: it's this month's report (a carry), not last month's done
  // one, though last month's is worded closer.
  closest = true;
  dedupes.length = 0;
  try {
    await read(b, '2026-10-15', [line('Fold the invented flyers', { existing_item_id: flyers.id }), line('File the monthly invented tally')]);
  } finally { closest = false; }
  assert.doesNotMatch(dedupes.join('\n'), /^CLOSED/m, 'no done item is offered to a line that isn\'t ticked');
  assert.equal(db.prepare('SELECT carry_days FROM items WHERE id=?').get(thisMonth.id).carry_days, thisMonth.carry_days + 1, 'it carries this month\'s');

  // The ladder's ticked line read again, reworded and without its id: offered the page's done items, labelled, and
  // taken as the item it ticked off.
  closest = true;
  dedupes.length = 0;
  const count = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  try {
    await read(b, '2026-10-15', [line('Fold the invented flyers', { existing_item_id: flyers.id }), line('Return the ladder', { status: 'done' })]);
  } finally { closest = false; }
  assert.match(dedupes.join('\n'), /^NEW n0: Return the ladder \(ticked\)$/m);
  assert.match(dedupes.join('\n'), new RegExp(`^CLOSED ${ladder.code}: Return the invented ladder$`, 'm'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, count, 'no copy of the done item');
  assert.ok(!mentionsOn(b).includes(ladder.id), 'and no line of it on this page');
});

test('a ticked line the dedupe matches to more than one item takes its own page\'s, whatever order they come in', async () => {
  const q = newPage(), b = newPage();
  await read(q, '2026-10-24', [line('Wash the invented truck', { status: 'done' }), line('Stay on q')]);
  await read(b, '2026-10-24', [line('Wash the invented truck', { status: 'done' })]); // another wash, ticked on b
  const [first, second] = db.prepare(`SELECT id, code FROM items WHERE text='Wash the invented truck' ORDER BY code`).all();
  await read(q, '2026-10-24', [line('Stay on q', { existing_item_id: row('Stay on q').id })]); // q's ticked line erased just now
  every = true;
  dedupes.length = 0;
  try {
    await read(b, '2026-10-24', [line('Wash the truck', { status: 'done' })]); // b's read again, reworded, without its id
  } finally { every = false; }
  const sent = dedupes.join('\n');
  assert.ok(sent.indexOf(`OTHER ${first.code}: Wash`) >= 0 && sent.indexOf(`OTHER ${first.code}: Wash`) < sent.indexOf(`CLOSED ${second.code}: Wash`),
    'the other page\'s is listed, and first');
  const live = db.prepare('SELECT item_id FROM item_mentions WHERE page_id=? AND gone_at IS NULL').all(b.id).map((m) => m.item_id);
  assert.deepEqual(live, [second.id], 'b\'s own, not the one whose line left q');
});

// Pages 1 and 2 of the fixture notebook: page 1 has two lines; once they exist (pages are read before any is applied),
// page 2 closes one by number and ticks the other.
let run = 0;
function script(params) {
  const text = userText(params);
  const page = Number(text.match(/page (\d+)/)[1]);
  const prior = new Map([...text.matchAll(/id=(\S+): (.+) \[\w+\]$/gm)].map((m) => [m[2], m[1]]));
  const base = { page_date: '2026-10-18', summary: `Invented page ${page}`, tags: [], legibility: 'high', uncertain_spans: [], closes: [], items: [] };
  const code = (t) => db.prepare('SELECT code FROM items WHERE text=?').get(t)?.code;
  if (page === 1) {
    return { ...base, transcription_md: '- ☐ Book the invented hall\n- ☐ Print the invented tickets',
      items: ['Book the invented hall', 'Print the invented tickets'].map((t) => line(t, { existing_item_id: prior.get(t) ?? null })) };
  }
  if (page === 2 && run === 1) return { ...base, transcription_md: '' };
  if (page === 2 && run === 2) { // both items are open, so the page closes them
    return { ...base, transcription_md: `✓${code('Book the invented hall')} hall booked\n☑ Print the invented tickets`,
      closes: [{ code: code('Book the invented hall'), action: 'done', snooze_until: null, evidence: `✓${code('Book the invented hall')}` },
        { code: code('Print the invented tickets'), action: 'done', snooze_until: null, evidence: '☑' }] };
  }
  if (page === 2) { // read again: the ticked line is read as a done item, with no id to give it
    return { ...base, transcription_md: '☑ Print the invented tickets', items: [line('Print the invented tickets', { status: 'done' })] };
  }
  return { ...base, transcription_md: '' };
}

test('the prompt doesn\'t list the items a page closed, and the ticked line read again is no copy', { skip: rendererMissing }, async () => {
  transcribe = script;
  for (run = 1; run <= 2; run++) {
    if (run > 1) markForRetranscription('all');
    await ingest({ mode: 'sync' });
  }
  assert.deepEqual(db.prepare(`SELECT text, status FROM items WHERE text LIKE '%invented hall' OR text LIKE '%invented tickets' ORDER BY code`).all(),
    [{ text: 'Book the invented hall', status: 'done' }, { text: 'Print the invented tickets', status: 'done' }]);
  const requests = fake.requests.length;
  markForRetranscription('all');
  await ingest({ mode: 'sync' });
  const page2 = fake.requests.slice(requests).filter((r) => r.purpose === 'transcribe').map((r) => userText(r.params)).find((t) => /page 2\b/.test(t));
  assert.match(page2, /ITEMS PREVIOUSLY EXTRACTED FROM THIS PAGE:\n- none$/);
  assert.doesNotMatch(page2, /invented hall|invented tickets/, 'the items it closed aren\'t in its prompt');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM items WHERE text='Print the invented tickets'`).get().n, 1, 'no copy of the ticked item');
});
