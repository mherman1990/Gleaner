// Ledger semantics against canned record_page results. Dedupe runs in mock mode (exact text match).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempEnv, pushSink } from './helpers.js';

tempEnv('ledger');
const { db, openItems, editItem, listItems, setItemStatus } = await import('../src/db.js');
const { applyPageResult } = await import('../src/pipeline/ledger.js');
const { normTime, fmtTime, localDate, config } = await import('../src/config.js');
const { reminderSweep } = await import('../src/digest/digest.js');

let n = 0;
function page(docId = 'doc1') {
  const id = `pg${++n}`;
  db.prepare('INSERT OR IGNORE INTO documents (id, name) VALUES (?, ?)').run(docId, docId);
  db.prepare(`INSERT INTO pages (id, doc_id, page_index, rm_hash, status) VALUES (?,?,?,?, 'rendered')`).run(id, docId, n, `hash${n}`);
  return db.prepare('SELECT * FROM pages WHERE id=?').get(id);
}
const item = (text, extra = {}) => ({ text, kind: 'action', status: 'open', person: null, assignee: null, due: null, due_time: null, priority: false, tags: [], ...extra });
const result = (items, extra = {}) => ({
  page_date: '2026-10-14', summary: 'notes', tags: [], transcription_md: 'md', legibility: 'high',
  uncertain_spans: [], items, closes: [], ...extra,
});
const apply = (p, r) => applyPageResult(p, r, '2026-10-01');
const items = () => db.prepare('SELECT * FROM items ORDER BY code').all();
const byCode = (code) => db.prepare('SELECT * FROM items WHERE code=?').get(code);

beforeEach(() => db.exec('DELETE FROM item_mentions; DELETE FROM items; DELETE FROM pages; DELETE FROM documents;'));

test('new items get sequential codes, fields, and a mention', async () => {
  const p = page();
  const s = await apply(p, result([
    item('Send Tom the 45Z comment draft', { kind: 'followup', person: 'Tom', priority: true, due: '2026-10-17', tags: ['45Z'] }),
    item('Call RMA about prevented planting', { due: 'Friday' }),
  ]));
  assert.equal(s.created, 2);
  const [a, b] = items();
  assert.deepEqual([a.code, b.code], [1, 2]);
  assert.equal(a.person, 'Tom');
  assert.equal(a.priority, 1);
  assert.equal(a.due, '2026-10-17');
  assert.equal(a.kind, 'followup');
  assert.equal(b.due, null, 'non-ISO due dates are discarded');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_mentions WHERE page_id=?').get(p.id).n, 2);
  const row = db.prepare('SELECT * FROM pages WHERE id=?').get(p.id);
  assert.equal(row.status, 'transcribed');
  assert.equal(row.transcribed_hash, row.rm_hash);
  assert.equal(row.page_date, '2026-10-14');
});

test('re-transcribing a page with existing_item_id updates in place', async () => {
  const p = page();
  await apply(p, result([item('Send Tom the draft')]));
  const id = items()[0].id;
  await apply(p, result([item('Send Tom the 45Z comment draft', { existing_item_id: id, due: '2026-10-20' })]));
  const all = items();
  assert.equal(all.length, 1);
  assert.equal(all[0].code, 1);
  assert.equal(all[0].text, 'Send Tom the 45Z comment draft');
  assert.equal(all[0].due, '2026-10-20');
});

test('re-extraction without existing_item_id keeps its number instead of being dropped as erased', async () => {
  const p = page();
  await apply(p, result([item('Draft SRE comment letter')]));
  await apply(p, result([item('Draft SRE comment letter')])); // model forgot to link it
  const all = items();
  assert.equal(all.length, 1);
  assert.equal(all[0].code, 1);
  assert.equal(all[0].status, 'open');
});

test('an item erased from its only page is dropped; one also written elsewhere stays open', async () => {
  const p1 = page(), p2 = page();
  await apply(p1, result([item('Erased thing'), item('Carried thing')]));
  await apply(p2, result([item('Carried thing')], { page_date: '2026-10-15' }));
  const s = await apply(p1, result([]));
  assert.equal(byCode(1).status, 'dropped');
  assert.equal(byCode(1).closed_by, 'erased');
  assert.equal(byCode(2).status, 'open');
  assert.ok(s.itemIds.includes(byCode(1).id));
});

// One ingest run applies its pages in notebook and page order, so a line moved from page 1 to page 2 (lasso cut and
// paste, or struck through and rewritten) is first erased, then written; the other way round when it moves back.
test('a line moved to another page keeps its item, in either order', async () => {
  const q = page(), p = page();
  await apply(q, result([item('Book the grain bin inspection'), item('Stay on this page')], { page_date: '2026-10-14' }));
  await apply(p, result([item('Order the fence posts')], { page_date: '2026-10-15' }));
  const moved = byCode(1);
  const run = [];
  run.push(await apply(q, result([item('Stay on this page', { existing_item_id: byCode(2).id })], { page_date: '2026-10-14' })));
  assert.deepEqual([byCode(1).status, byCode(1).closed_by], ['dropped', 'erased'], 'between the two pages, it looks erased');
  run.push(await apply(p, result([item('Order the fence posts', { existing_item_id: byCode(3).id }), item('Book the grain bin inspection')],
    { page_date: '2026-10-15' })));
  assert.deepEqual(items().map((i) => [i.code, i.text, i.status]),
    [[1, 'Book the grain bin inspection', 'open'], [2, 'Stay on this page', 'open'], [3, 'Order the fence posts', 'open']]);
  const after = byCode(1);
  assert.deepEqual([after.id, after.closed_by, after.closed_at, after.carry_days, after.last_page_id], [moved.id, null, null, 2, p.id]);
  assert.deepEqual([run[1].created, run[1].carried], [0, 1]);

  // And back again, with the page it lands on read first: still open, still item 1.
  await apply(q, result([item('Stay on this page', { existing_item_id: byCode(2).id }), item('Book the grain bin inspection')], { page_date: '2026-10-14' }));
  await apply(p, result([item('Order the fence posts', { existing_item_id: byCode(3).id })], { page_date: '2026-10-15' }));
  assert.deepEqual([items().length, byCode(1).status], [3, 'open']);
});

test('a line that one read missed, and the next one links again, reopens its item', async () => {
  const p = page();
  await apply(p, result([item('Grease the invented auger')]));
  await apply(p, result([])); // the line was missed (or erased and later rewritten)
  assert.equal(byCode(1).status, 'dropped');
  await apply(p, result([item('Grease the invented auger', { existing_item_id: byCode(1).id })]));
  assert.deepEqual([items().length, byCode(1).status, byCode(1).closed_by], [1, 'open', null]);
  setItemStatus(byCode(1).id, 'dropped', 'ui'); // dropped by hand: a re-read leaves it dropped
  await apply(p, result([item('Grease the invented auger', { existing_item_id: byCode(1).id })]));
  assert.equal(byCode(1).status, 'dropped');
});

test('a moved line that is ticked closes its item; one erased days ago is a new item', async () => {
  const q = page(), p = page();
  await apply(q, result([item('Renew the invented permit'), item('Fix the invented gate')]));
  await apply(q, result([]));
  await apply(p, result([item('Renew the invented permit', { status: 'done' })]));
  assert.deepEqual([items().length, byCode(1).status, byCode(1).closed_by], [2, 'done', 'handwriting']);
  db.prepare(`UPDATE items SET closed_at=? WHERE code=2`).run(new Date(Date.now() - 4 * 86400e3).toISOString()); // erased 4 days ago
  await apply(p, result([item('Renew the invented permit', { status: 'done', existing_item_id: byCode(1).id }), item('Fix the invented gate')]));
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'done'], [2, 'dropped'], [3, 'open']], 'written again after that, it\'s new');
});

test('carry-forward across days bumps carry_days instead of duplicating', async () => {
  await apply(page(), result([item('Call Brazil desk at USDA FAS')], { page_date: '2026-10-13' }));
  const s = await apply(page(), result([item('Call Brazil desk at USDA FAS')], { page_date: '2026-10-15' }));
  assert.equal(s.carried, 1);
  assert.equal(s.created, 0);
  const [it] = items();
  assert.equal(items().length, 1);
  assert.equal(it.carry_days, 2);
  assert.equal(it.first_seen, '2026-10-13');
  assert.equal(it.last_seen, '2026-10-15');
});

test('number closes: done, dropped, snooze — and closed items stay closed', async () => {
  await apply(page(), result([item('One'), item('Two'), item('Three'), item('Four')]));
  const s = await apply(page(), result([], {
    closes: [
      { code: 1, action: 'done', evidence: '✓1' },
      { code: 2, action: 'dropped', evidence: 'x2' },
      { code: 3, action: 'snooze', snooze_until: '2999-01-01', evidence: '3 → later' },
      { code: 4, action: 'snooze', snooze_until: '2000-01-01', evidence: '4 → past' },
      { code: 99, action: 'done', evidence: '✓99' },
    ],
  }));
  assert.equal(s.closed, 2);
  assert.equal(byCode(1).status, 'done');
  assert.equal(byCode(1).close_evidence, '✓1');
  assert.equal(byCode(2).status, 'dropped');
  assert.equal(byCode(3).status, 'snoozed');
  assert.deepEqual(openItems().map((i) => i.code), [4], 'snoozed items return once the date passes');

  await apply(page(), result([], { closes: [{ code: 1, action: 'dropped', evidence: 'x1' }] }));
  assert.equal(byCode(1).status, 'done');
});

test('a checked box on the page creates an already-closed item', async () => {
  await apply(page(), result([item('Book hotel for Commodity Classic', { status: 'done' })]));
  assert.equal(byCode(1).status, 'done');
  assert.equal(byCode(1).closed_by, 'handwriting');
});

test('no written date falls back to the notebook date; a changed date reports the old one', async () => {
  const p = page();
  const first = await apply(p, result([item('Undated thing')], { page_date: null }));
  assert.equal(first.pageDate, '2026-10-01');
  assert.equal(byCode(1).first_seen, '2026-10-01');
  const second = await apply(p, result([item('Undated thing', { existing_item_id: byCode(1).id })], { page_date: '2026-10-14' }));
  assert.equal(second.pageDate, '2026-10-14');
  assert.equal(second.prevDate, '2026-10-01');
  assert.deepEqual(db.prepare('SELECT page_date FROM item_mentions').all(), [{ page_date: '2026-10-14' }]);
  assert.equal(byCode(1).carry_days, 1);
});

test('times and assignees are read from the page; a time with no date means the page date', async () => {
  await apply(page(), result([
    item('Call Jen about the RVO letter', { due: '2026-10-16', due_time: '14:00' }),
    item('Book the Ames room', { due_time: '9:30am', assignee: 'Kelsey' }),
    item('Send the deck', { due_time: 'later' }),
  ]));
  assert.deepEqual([byCode(1).due, byCode(1).due_time, byCode(1).assignee], ['2026-10-16', '14:00', null]);
  assert.deepEqual([byCode(2).due, byCode(2).due_time, byCode(2).assignee], ['2026-10-14', '09:30', 'Kelsey']);
  assert.deepEqual([byCode(3).due, byCode(3).due_time], [null, null], 'an unreadable time is dropped');
});

test('times: parsing and display', () => {
  for (const [s, want] of [['14:05', '14:05'], ['9:30', '09:30'], ['2pm', '14:00'], ['2:30 PM', '14:30'], ['12am', '00:00'],
    ['12pm', '12:00'], ['11 a.m.', '11:00'], ['14', null], ['25:00', null], ['13pm', null], ['', null], [null, null]]) {
    assert.equal(normTime(s), want, String(s));
  }
  assert.deepEqual(['14:00', '09:30', '00:00', '12:15'].map(fmtTime), ['2pm', '9:30am', '12am', '12:15pm']);
});

test('hand edits survive a re-read of the page; fields not edited still follow the page', async () => {
  const p = page();
  await apply(p, result([item('USB Report', { due: '2026-10-20' })]));
  const it = byCode(1);
  assert.deepEqual(editItem(it.id, { text: 'USB report draft', due_time: '2pm', assignee: 'Jen' }, 'ui'), ['text', 'due_time', 'assignee']);
  assert.deepEqual(editItem(it.id, { assignee: 'Jen' }, 'ui'), [], 'no change, nothing marked');

  await apply(p, result([item('USB Report', { existing_item_id: it.id, due: '2026-10-22', person: 'Tom', assignee: 'Kelsey' })]));
  const after = byCode(1);
  assert.equal(after.text, 'USB report draft');
  assert.equal(after.assignee, 'Jen');
  assert.deepEqual([after.due, after.due_time], ['2026-10-20', '14:00'], 'the date and time are kept together');
  assert.equal(after.person, 'Tom', 'a field never edited still updates');
  assert.deepEqual(JSON.parse(after.edited), ['text', 'due_time', 'assignee']);
});

test('editItem: clearing, defaults, validation, and fresh nudges for a new deadline', async () => {
  await apply(page(), result([item('Edit me')]));
  const id = byCode(1).id;
  editItem(id, { due_time: '15:00' }, 'ui');
  assert.deepEqual([byCode(1).due, byCode(1).due_time], [localDate(), '15:00'], 'a time alone means today');
  db.prepare(`UPDATE items SET last_nudged='2026-10-01T12:00:00Z', nudge_count=3 WHERE id=?`).run(id);
  editItem(id, { due: '2026-10-30' }, 'ui');
  assert.deepEqual([byCode(1).due, byCode(1).due_time, byCode(1).nudge_count, byCode(1).last_nudged], ['2026-10-30', '15:00', 0, null]);
  editItem(id, { due: null }, 'ui');
  assert.deepEqual([byCode(1).due, byCode(1).due_time], [null, null], 'no date, no time');
  editItem(id, { assignee: '  Jen  ' }, 'ui');
  assert.equal(byCode(1).assignee, 'Jen');
  editItem(id, { assignee: '' }, 'ui');
  assert.equal(byCode(1).assignee, null);
  assert.throws(() => editItem(id, { due: '10/30' }, 'ui'), /YYYY-MM-DD/);
  assert.throws(() => editItem(id, { due: '2026-02-31' }, 'ui'), /YYYY-MM-DD/);
  assert.throws(() => editItem(id, { due_time: 'soon' }, 'ui'), /time like/);
  assert.throws(() => editItem(id, { due: null, due_time: '9am' }, 'ui'), /needs a due date/);
  assert.throws(() => editItem(id, { text: '  ' }, 'ui'), /empty/);
  assert.equal(byCode(1).due, null, 'a rejected edit changes nothing');
});

test('listItems: open, snoozed, closed, and reopening', async () => {
  await apply(page(), result([item('A'), item('B'), item('C'), item('D')]));
  setItemStatus(byCode(1).id, 'done', 'api');
  setItemStatus(byCode(2).id, 'snoozed', 'api', null, '2999-01-01');
  setItemStatus(byCode(3).id, 'dropped', 'api');
  const codes = (s) => listItems(s).map((i) => i.code).sort();
  assert.deepEqual(codes('open'), [4]);
  assert.deepEqual(codes('snoozed'), [2]);
  assert.deepEqual(codes('closed'), [1, 3]);
  assert.deepEqual(codes('all'), [1, 2, 3, 4]);
  assert.throws(() => listItems('bogus'), /status must be/);
  setItemStatus(byCode(1).id, 'open', 'api');
  assert.deepEqual([byCode(1).status, byCode(1).closed_at, byCode(1).closed_by], ['open', null, null]);
  assert.deepEqual(codes('open'), [1, 4]);
});

test('reminders: a timed item waits until shortly before its time; overdue and untimed ones go on the first sweep', async (t) => {
  await apply(page(), result([
    item('Untimed today', { due: '2026-10-20' }),
    item('At 2:20', { due: '2026-10-20', due_time: '14:20' }),
    item('At 3pm', { due: '2026-10-20', due_time: '15:00' }),
    item('Yesterday late', { due: '2026-10-19', due_time: '23:00' }),
    item('Tomorrow', { due: '2026-10-21' }),
  ]));
  const nudged = () => db.prepare('SELECT code FROM items WHERE nudge_count > 0 ORDER BY code').all().map((r) => r.code);
  const sink = await pushSink();
  t.after(() => { sink.close(); config.notify.ntfyUrl = ''; });
  config.notify.ntfyUrl = sink.url;
  assert.equal((await reminderSweep({ at: new Date('2026-10-20T14:00:00-05:00') })).nudged, 3);
  assert.deepEqual(nudged(), [1, 2, 4]);
  assert.match(sink.hits[0].body, /At 2:20 — at 2:20pm/);
  assert.equal((await reminderSweep({ at: new Date('2026-10-20T14:35:00-05:00') })).nudged, 1);
  assert.deepEqual(nudged(), [1, 2, 3, 4]);
  assert.equal((await reminderSweep({ at: new Date('2026-10-20T16:00:00-05:00') })).nudged, 0, 'once per item per day');
  assert.equal(sink.hits.length, 2);
});

test('a nudge that reaches no one is not counted', async (t) => {
  await apply(page(), result([item('Due today', { due: '2026-10-20' })]));
  const at = new Date('2026-10-20T09:00:00-05:00');
  const count = () => byCode(1).nudge_count;
  config.notify.ntfyUrl = '';
  assert.deepEqual(await reminderSweep({ at }), { nudged: 0, due: 1, sent: { teams: 'skipped', ntfy: 'skipped' } });
  const failing = await pushSink(500);
  t.after(() => { failing.close(); config.notify.ntfyUrl = ''; });
  config.notify.ntfyUrl = failing.url;
  assert.equal((await reminderSweep({ at })).nudged, 0);
  assert.equal(failing.hits.length, 1, 'it was tried');
  assert.deepEqual([count(), byCode(1).last_nudged], [0, null], 'still owed: the next sweep tries again');
});
