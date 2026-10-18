// A page that closed or snoozed items from other pages (by number, "✓1" / "3 → Fri", or by ticking a line for them)
// is read again: the prompt lists those items apart from the page's own lines; a line the model links to one only
// ticks it off (its tags, due date and carry count stay); a done task written again is a new item; and the dedupe
// offers done items only to ticked lines, labelled as closed. Real SDK against the fake API. All content is invented.
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
// line to an OPEN one; with closest set, it picks the closest wording instead, as a real model might.
const dedupes = [];
let closest = false;
function dedupe(params) {
  const text = userText(params);
  dedupes.push(text);
  const words = (t) => new Set(t.toLowerCase().split(/\W+/).filter(Boolean));
  const near = (a, b) => [...words(a)].filter((w) => words(b).has(w)).length / Math.max(words(a).size, words(b).size);
  const news = [...text.matchAll(/^NEW (\S+): (.+?)( \(ticked\))?$/gm)].map((m) => ({ ref: m[1], t: m[2], ticked: !!m[3] }));
  const olds = [...text.matchAll(/^(OPEN|CLOSED) (\d+): (.+)$/gm)].map((m) => ({ open: m[1] === 'OPEN', code: Number(m[2]), t: m[3] }));
  return { matches: news.flatMap((n) => {
    const fits = olds.filter((o) => (closest ? near(o.t, n.t) >= 0.5 : o.t === n.t));
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

test('a line linked to an item the page closed by number only ticks it off; a done task written again is new', async () => {
  const a = newPage();
  await read(a, '2026-10-13', [line('Order the invented seed', { tags: ['orchard'] }), line('Call Tom about the invented letter', { tags: ['orchard'], due: '2026-10-15' }),
    line('Sign the invented lease')]);
  const [seed, call] = ['Order the invented seed', 'Call Tom about the invented letter'].map(row);
  const b = newPage();
  await read(b, '2026-10-14', [], [{ code: seed.code, action: 'done', snooze_until: null, evidence: `✓${seed.code}` },
    { code: call.code, action: 'snooze', snooze_until: '2999-01-01', evidence: `${call.code} → Fri` }]);
  const before = { seed: row('Order the invented seed'), call: row('Call Tom about the invented letter') };
  const mark = lastEvent();
  // A re-read where the model links the "✓" and "→ Fri" lines to the listed items, reading "→ Fri" as a due date, and
  // the seed order is written again unticked as a new order.
  await read(b, '2026-10-14', [
    line('Order the invented seed', { existing_item_id: seed.id, status: 'done' }),
    line('Call Tom about the invented letter', { existing_item_id: call.id, due: '2026-10-17' }),
    line('Order the invented seed', { existing_item_id: seed.id }),
  ]);
  assert.deepEqual(row('Call Tom about the invented letter'), before.call, 'the snoozed item keeps its tags, due date, snooze and carry count');
  assert.deepEqual(row('Order the invented seed'), before.seed);
  assert.deepEqual(db.prepare('SELECT status FROM items WHERE text=? ORDER BY code').all('Order the invented seed').map((i) => i.status), ['done', 'open']);
  assert.deepEqual(mentionsOn(b), [db.prepare(`SELECT id FROM items WHERE text='Order the invented seed' AND status='open'`).get().id],
    'only the new order is a line of this page');
  assert.deepEqual(eventsSince(mark).map((e) => e.field), ['created'], 'nothing changed on the closed or snoozed item');

  // A tick on an item this page snoozed closes it, and changes nothing else.
  await read(b, '2026-10-14', [line('Call Tom about the invented letter', { existing_item_id: call.id, status: 'done', due: '2026-10-17' })]);
  assert.deepEqual([row('Call Tom about the invented letter').status, row('Call Tom about the invented letter').due], ['done', '2026-10-15']);
  assert.equal(row('Sign the invented lease').status, 'open', 'an item the page never named is untouched');
});

test('the dedupe offers done items only to a ticked line, and labels them closed', async () => {
  const a = newPage();
  await read(a, '2026-10-15', [line('Send the weekly invented report'), line('Return the invented ladder')]);
  const [old, ladder] = ['Send the weekly invented report', 'Return the invented ladder'].map(row);
  const b = newPage(); // closes last week's report by number and ticks off the ladder's line
  await read(b, '2026-10-15', [line('Fold the invented flyers')], [{ code: old.code, action: 'done', snooze_until: null, evidence: `✓${old.code}` },
    { code: ladder.code, action: 'done', snooze_until: null, evidence: '☑' }]);
  const flyers = row('Fold the invented flyers');
  await read(newPage(), '2026-10-16', [line('Send this week\'s weekly invented report')]); // this week's, open
  const thisWeek = row('Send this week\'s weekly invented report');

  // On b, the recurring task is written again, unticked: it's this week's report (a carry), not last week's done one,
  // though last week's is worded closer.
  closest = true;
  dedupes.length = 0;
  try {
    await read(b, '2026-10-15', [line('Fold the invented flyers', { existing_item_id: flyers.id }), line('Send the weekly invented report')]);
  } finally { closest = false; }
  assert.doesNotMatch(dedupes.join('\n'), /^CLOSED/m, 'no done item is offered to a line that isn\'t ticked');
  assert.equal(db.prepare('SELECT carry_days FROM items WHERE id=?').get(thisWeek.id).carry_days, thisWeek.carry_days + 1, 'it carries this week\'s');

  // The ladder's ticked line read again without its id: offered the page's done items, labelled, and taken as the
  // item it ticked off.
  dedupes.length = 0;
  const count = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  await read(b, '2026-10-15', [line('Fold the invented flyers', { existing_item_id: flyers.id }), line('Return the invented ladder', { status: 'done' })]);
  assert.match(dedupes.join('\n'), /^NEW n0: Return the invented ladder \(ticked\)$/m);
  assert.match(dedupes.join('\n'), new RegExp(`^CLOSED ${ladder.code}: Return the invented ladder$`, 'm'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, count, 'no copy of the done item');
  assert.deepEqual(mentionsOn(b).sort(), [flyers.id, thisWeek.id].sort(), 'and the page has no line of it');
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
  if (page === 2) { // read again: they're listed as this page's closes, and the ticked line is linked to its item
    return { ...base, transcription_md: '☑ Print the invented tickets', items: [line('Print the invented tickets', { existing_item_id: prior.get('Print the invented tickets'), status: 'done' })] };
  }
  return { ...base, transcription_md: '' };
}

test('the prompt lists the items a page closed apart from its own lines, and the ticked line read again is linked', { skip: rendererMissing }, async () => {
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
  const page2 = fake.requests.slice(requests).map((r) => userText(r.params)).find((t) => /page 2\b/.test(t));
  const ids = Object.fromEntries(db.prepare(`SELECT text, id FROM items`).all().map((i) => [i.text, i.id]));
  assert.match(page2, /ITEMS PREVIOUSLY EXTRACTED FROM THIS PAGE:\n- none\n/);
  assert.match(page2, new RegExp(`ITEMS THIS PAGE CLOSED OR SNOOZED[^\\n]*\\n- id=${ids['Book the invented hall']}: Book the invented hall \\[done\\]\\n` +
    `- id=${ids['Print the invented tickets']}: Print the invented tickets \\[done\\]`));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM items WHERE text='Print the invented tickets'`).get().n, 1, 'no copy of the ticked item');
});
