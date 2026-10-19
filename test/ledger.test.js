// Ledger semantics against canned record_page results. Dedupe runs in mock mode (exact text match).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tempEnv, pushSink } from './helpers.js';

tempEnv('ledger');
const { db, openItems, editItem, listItems, setItemStatus } = await import('../src/db.js');
const { applyPageResult, pageEmptied } = await import('../src/pipeline/ledger.js');
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

beforeEach(() => db.exec('DELETE FROM item_mentions; DELETE FROM items; DELETE FROM pages; DELETE FROM documents; DELETE FROM events; DELETE FROM page_closes; DELETE FROM page_tags; DELETE FROM item_sources;'));
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();
// Backdate when item `code`'s line left its pages (and its drop, if that dropped it) by `h` hours.
const leftAgo = (code, h) => {
  const id = byCode(code).id;
  db.prepare('UPDATE item_mentions SET gone_at=? WHERE item_id=? AND gone_at IS NOT NULL').run(hoursAgo(h), id);
  db.prepare(`UPDATE items SET closed_at=? WHERE id=? AND closed_by='erased'`).run(hoursAgo(h), id);
};
const sources = () => db.prepare('SELECT i.code AS item, s.code AS source FROM item_sources x JOIN items i ON i.id=x.item_id JOIN items s ON s.id=x.source_id ORDER BY 1, 2').all().map((r) => [r.item, r.source]);
const statusEvents = (code) => db.prepare(`SELECT client, old, new FROM events WHERE item_code=? AND field='status' ORDER BY id`).all(code).map((e) => `${e.client}:${e.old}->${e.new}`);

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

  // Erased from the page it moved to, it's dropped: the page it came from no longer has its line either.
  await apply(p, result([item('Order the fence posts', { existing_item_id: byCode(3).id })], { page_date: '2026-10-15' }));
  assert.deepEqual([byCode(1).status, byCode(1).closed_by], ['dropped', 'erased']);
});

test('moved with the page it lands on read first, then erased there: dropped', async () => {
  const q = page(), p = page();
  await apply(q, result([item('Stack the invented pallets'), item('Stay on this page')], { page_date: '2026-10-14' }));
  await apply(p, result([item('Stack the invented pallets')], { page_date: '2026-10-15' })); // the paste, read first
  await apply(q, result([item('Stay on this page', { existing_item_id: byCode(2).id })], { page_date: '2026-10-14' })); // then the cut
  assert.equal(byCode(1).status, 'open', 'still on p');
  await apply(p, result([]), { page_date: '2026-10-15' });
  assert.deepEqual([items().length, byCode(1).status], [2, 'dropped']);
});

test('a line that leaves a page and comes back counts as on that page again', async () => {
  const a = page(), b = page();
  await apply(a, result([item('Tune the invented planter')], { page_date: '2026-10-13' }));
  await apply(b, result([item('Tune the invented planter')], { page_date: '2026-10-14' })); // carried
  await apply(b, result([], { page_date: '2026-10-14' })); // gone from b; still on a
  assert.equal(byCode(1).status, 'open');
  await apply(b, result([item('Tune the invented planter', { existing_item_id: byCode(1).id })], { page_date: '2026-10-14' })); // back on b
  await apply(a, result([], { page_date: '2026-10-13' })); // gone from a: still on b
  assert.equal(byCode(1).status, 'open');
});

test('a move is a line written elsewhere within hours; a task erased and written again the next day is a new item', async () => {
  const [d1, d2, d3] = [page(), page(), page()];
  await apply(d1, result([item('Check the invented bin temps')], { page_date: '2026-10-14' }));
  await apply(d1, result([], { page_date: '2026-10-14' })); // done, and erased
  leftAgo(1, 5); // in the sync before last: still a move
  await apply(d2, result([item('Check the invented bin temps')], { page_date: '2026-10-14' }));
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'open']]);
  await apply(d2, result([], { page_date: '2026-10-14' }));
  leftAgo(1, 7); // erased this morning, written again this afternoon
  await apply(d3, result([item('Check the invented bin temps')], { page_date: '2026-10-15' }));
  assert.deepEqual(items().map((i) => [i.code, i.status, i.carry_days]), [[1, 'dropped', 1], [2, 'open', 1]]);
});

test('a line that one read missed, and the next one links again, reopens its item', async () => {
  const p = page();
  await apply(p, result([item('Grease the invented auger')]));
  await apply(p, result([])); // the line was missed (or erased and rewritten)
  assert.equal(byCode(1).status, 'dropped');
  await apply(p, result([item('Grease the auger', { existing_item_id: byCode(1).id })])); // linked back, worded a little differently
  assert.deepEqual([items().length, byCode(1).status, byCode(1).closed_by], [1, 'open', null]);
  setItemStatus(byCode(1).id, 'dropped', 'ui'); // dropped by hand: a re-read leaves it dropped
  await apply(p, result([item('Grease the invented auger', { existing_item_id: byCode(1).id })]));
  assert.equal(byCode(1).status, 'dropped');
});

test('a line linked to an item erased from this page long ago is the task written again: a new item', async () => {
  const p = page();
  await apply(p, result([item('Pay the invented rent', { due: '2026-09-15' })]));
  editItem(byCode(1).id, { due: '2026-09-16' }, 'ui');
  await apply(p, result([])); // paid, and erased
  leftAgo(1, 24 * 30);
  await apply(p, result([item('Pay the invented rent', { existing_item_id: byCode(1).id, due: '2026-10-31' })]));
  assert.deepEqual(items().map((i) => [i.code, i.status, i.due]), [[1, 'dropped', '2026-09-16'], [2, 'open', '2026-10-31']]);
});

test('a dropped item is a real drop once a person drops it, even if its line had left a page', async () => {
  const p = page();
  await apply(p, result([item('Grease the invented chain')]));
  await apply(p, result([])); // the line left the page: dropped by "erased"
  assert.equal(setItemStatus(byCode(1).id, 'dropped', 'cli', 'not needed'), 1);
  assert.deepEqual([byCode(1).closed_by, byCode(1).close_evidence], ['cli', 'not needed']);
  assert.deepEqual(statusEvents(1), ['erased:open->dropped', 'cli:dropped->dropped']);
  await apply(page(), result([item('Grease the invented chain')])); // written on another page soon after
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'dropped'], [2, 'open']], 'not brought back');
});

test('a close by number wins over a move: an item closed while its line was between pages stays closed', async () => {
  const q = page(), r = page();
  await apply(q, result([item('Send the invented draft')], { page_date: '2026-10-14' }));
  await apply(q, result([], { page_date: '2026-10-14' })); // the line is cut (or a read missed it)
  await apply(r, result([], { page_date: '2026-10-15', closes: [{ code: 1, action: 'done', snooze_until: null, evidence: '✓1' }] }));
  assert.deepEqual([byCode(1).status, byCode(1).closed_by], ['done', 'handwriting']);
  // Its line read on q again is the task written again: a done task written again is a new commitment, so a read that
  // had only missed the line costs a visible duplicate rather than swallowing a real new task.
  await apply(q, result([item('Send the invented draft', { existing_item_id: byCode(1).id })], { page_date: '2026-10-14' }));
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'done'], [2, 'open']]);
});

test('nudges start again when the page gives a new due date or time, whichever order a move is read in', async () => {
  const nudged = (code) => db.prepare(`UPDATE items SET last_nudged='2026-10-16T14:00:00Z', nudge_count=3 WHERE code=?`).run(code);
  // A move, cut page read first (dropped, then reopened) and paste page read first (carried): the same due date
  // either way, so the nudges stand either way.
  for (const cutFirst of [true, false]) {
    db.exec('DELETE FROM item_mentions; DELETE FROM items;');
    const q = page(), p = page();
    await apply(q, result([item('Call the invented office', { due: '2026-10-14' }), item('Stay on this page')], { page_date: '2026-10-14' }));
    nudged(1);
    const cut = () => apply(q, result([item('Stay on this page', { existing_item_id: byCode(2).id })], { page_date: '2026-10-14' }));
    const paste = () => apply(p, result([item('Call the invented office', { due: '2026-10-14' })], { page_date: '2026-10-16' }));
    if (cutFirst) { await cut(); await paste(); } else { await paste(); await cut(); }
    assert.deepEqual([byCode(1).status, byCode(1).nudge_count], ['open', 3], cutFirst ? 'cut page first' : 'paste page first');
  }
  const p = db.prepare('SELECT * FROM pages ORDER BY rowid DESC').get();
  const id = byCode(1).id;
  await apply(p, result([item('Call the invented office', { existing_item_id: id, due: '2026-10-14', due_time: '2pm' })], { page_date: '2026-10-16' }));
  assert.deepEqual([byCode(1).due_time, byCode(1).nudge_count, byCode(1).last_nudged], ['14:00', 0, null], 'a new time');
  nudged(1);
  await apply(p, result([item('Call the invented office', { existing_item_id: id, due: '2026-10-20', due_time: '2pm' })], { page_date: '2026-10-16' }));
  assert.deepEqual([byCode(1).due, byCode(1).nudge_count], ['2026-10-20', 0], 'a new date');
});

test('on a page with no written date, a time with no date doesn\'t restart the nudges as the notebook date moves', async () => {
  const p = page();
  const read = (fallback, extra = {}) => applyPageResult(p, result([item('Call the invented vet', { due_time: '2pm', ...extra })], { page_date: null }), fallback);
  await read('2026-10-12');
  db.prepare(`UPDATE items SET last_nudged='2026-10-12T19:00:00Z', nudge_count=3 WHERE code=1`).run();
  await read('2026-10-14', { existing_item_id: byCode(1).id });
  assert.equal(byCode(1).nudge_count, 3);
});

test('a snoozed item\'s line moved to another page stays one item, still snoozed', async () => {
  const q = page(), p = page();
  await apply(q, result([item('Call the invented lab'), item('Stay on this page')], { page_date: '2026-10-14' }));
  setItemStatus(byCode(1).id, 'snoozed', 'handwriting', null, '2999-01-01');
  await apply(q, result([item('Stay on this page', { existing_item_id: byCode(2).id })], { page_date: '2026-10-14' }));
  assert.ok(db.prepare('SELECT gone_at FROM item_mentions WHERE item_id=? AND page_id=?').get(byCode(1).id, q.id).gone_at, 'its line left q');
  await apply(p, result([item('Call the invented lab')], { page_date: '2026-10-15' }));
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'snoozed'], [2, 'open']]);
});

test('a line moved onto a page that once closed its item by number is moved, not swallowed', async () => {
  for (const alongside of [[], [item('Rake the invented yard', { status: 'done' })]]) { // and with a new ticked line there too
    db.exec('DELETE FROM item_mentions; DELETE FROM items; DELETE FROM page_closes;');
    const q = page(), p = page();
    await apply(q, result([item('Order the invented filters')], { page_date: '2026-10-14' }));
    await apply(p, result([], { page_date: '2026-10-15', closes: [{ code: 1, action: 'done', snooze_until: null, evidence: '✓1' }] }));
    setItemStatus(byCode(1).id, 'open', 'ui'); // reopened by hand
    await apply(q, result([], { page_date: '2026-10-14' })); // cut from q…
    await apply(p, result([item('Order the invented filters'), ...alongside], { page_date: '2026-10-15' })); // …and pasted on p
    assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'open'], ...alongside.map(() => [2, 'done'])]);
  }
});

test('a moved line that is ticked closes its item; one erased days ago is a new item', async () => {
  const q = page(), p = page();
  await apply(q, result([item('Renew the invented permit'), item('Fix the invented gate')]));
  await apply(q, result([]));
  await apply(p, result([item('Renew the invented permit', { status: 'done' })]));
  assert.deepEqual([items().length, byCode(1).status, byCode(1).closed_by], [2, 'done', 'handwriting']);
  assert.deepEqual(statusEvents(1), ['erased:open->dropped', 'handwriting:dropped->done'], 'closed straight from dropped, never reopened');
  leftAgo(2, 24 * 4); // erased 4 days ago
  await apply(p, result([item('Renew the invented permit', { status: 'done', existing_item_id: byCode(1).id }), item('Fix the invented gate')]));
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'done'], [2, 'dropped'], [3, 'open']], 'written again after that, it\'s new');
});

test('a task ticked, erased, and written again on its page is a new item, written from the old one', async () => {
  const p = page();
  await apply(p, result([item('Call the invented vet', { tags: ['farm'] })]));
  await apply(p, result([item('Call the invented vet', { existing_item_id: byCode(1).id, status: 'done', tags: ['farm'] })]));
  db.prepare('UPDATE items SET closed_at=? WHERE code=1').run(hoursAgo(24 * 6)); // ticked six days ago…
  await apply(p, result([])); // …and erased to tidy the page
  leftAgo(1, 24 * 5);
  await apply(p, result([item('Call the invented vet', { existing_item_id: byCode(1).id })])); // written again; the model links it
  assert.deepEqual(items().map((i) => [i.code, i.status, i.tags]), [[1, 'done', '["farm"]'], [2, 'open', '[]']]);
  assert.deepEqual(sources(), [[2, 1]]);
});

test('a ticked or struck line erased and written again before the next read is a new item, even linked to the old one', async () => {
  for (const mark of ['done', 'dropped']) {
    db.exec('DELETE FROM item_mentions; DELETE FROM items; DELETE FROM item_sources;');
    const todo = page();
    const keep = () => item('Keep this line', { existing_item_id: byCode(2).id });
    await apply(todo, result([item('Pay the invented rent'), item('Keep this line')]));
    await apply(todo, result([item('Pay the invented rent', { existing_item_id: byCode(1).id, status: mark }), keep()]));
    // Within one sync: the old line erased and the task written again (or only its tick erased). The prompt lists the
    // closed item, and the model links the new line to it.
    await apply(todo, result([item('Pay the invented rent', { existing_item_id: byCode(1).id }), keep()]));
    assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, mark], [2, 'open'], [3, 'open']], `${mark}: a new open item`);
    assert.deepEqual(sources(), [[3, 1]]);
    // Read again, linked to either, it stays item 3.
    await apply(todo, result([item('Pay the invented rent', { existing_item_id: byCode(3).id }), keep()]));
    await apply(todo, result([item('Pay the invented rent', { existing_item_id: byCode(1).id }), keep()]));
    assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, mark], [2, 'open'], [3, 'open']], `${mark}: read again`);
  }
});

test('a tick or strike already read isn\'t applied again when a person has reopened the item', async () => {
  const p = page();
  await apply(p, result([item('Fix the invented pump', { status: 'done' }), item('Stop the invented leak')]));
  await apply(p, result([item('Fix the invented pump', { existing_item_id: byCode(1).id, status: 'done' }),
    item('Stop the invented leak', { existing_item_id: byCode(2).id, status: 'dropped' })]));
  for (const code of [1, 2]) setItemStatus(byCode(code).id, 'open', 'ui'); // not done after all
  await apply(p, result([item('Fix the invented pump', { existing_item_id: byCode(1).id, status: 'done' }),
    item('Stop the invented leak', { existing_item_id: byCode(2).id, status: 'dropped' }), item('Order the invented gasket')]));
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'open'], [2, 'open'], [3, 'open']]);
  assert.deepEqual(statusEvents(1), ['handwriting:open->done', 'ui:done->open']);
});

test('a close by number is made once: a re-read doesn\'t undo a reopen or a snooze set by hand since', async () => {
  const p = page(), q = page();
  await apply(p, result([item('Order the invented seed'), item('Call the invented lab')]));
  const marks = [{ code: 1, action: 'done', snooze_until: null, evidence: '✓1' }, { code: 2, action: 'snooze', snooze_until: '2026-10-16', evidence: '2 → Fri' }];
  await apply(q, result([], { closes: marks }));
  assert.deepEqual(items().map((i) => [i.status, i.snooze_until]), [['done', null], ['snoozed', '2026-10-16']]);
  setItemStatus(byCode(1).id, 'open', 'ui'); // a misread close, undone by hand
  // q read again: the marks are still there, and "→ Fri" on a page with no date now reads as next Friday.
  await apply(q, result([item('Water the invented trees')], { closes: [marks[0], { ...marks[1], snooze_until: '2026-10-23' }] }));
  assert.deepEqual(items().slice(0, 2).map((i) => [i.status, i.snooze_until]), [['open', null], ['snoozed', '2026-10-16']]);
  assert.deepEqual(statusEvents(1), ['handwriting:open->done', 'ui:done->open']);
});

test('a task struck on one page and written again on another is one open item, whichever page is read first', async () => {
  for (const order of ['struck first', 'written first']) {
    db.exec('DELETE FROM item_mentions; DELETE FROM items; DELETE FROM item_sources;');
    const p = page(), q = page();
    await apply(p, result([item('Book the invented hall'), item('Keep this line')], { page_date: '2026-10-14' }));
    const struck = () => apply(p, result([item('Book the invented hall', { existing_item_id: byCode(1).id, status: 'dropped' }),
      item('Keep this line', { existing_item_id: byCode(2).id })], { page_date: '2026-10-14' }));
    const written = () => apply(q, result([item('Book the invented hall')], { page_date: '2026-10-15' }));
    if (order === 'struck first') { await struck(); await written(); } else { await written(); await struck(); }
    await written(); // and q read again
    const hall = items().filter((i) => i.text === 'Book the invented hall');
    assert.deepEqual(hall.filter((i) => i.status === 'open').length, 1, `${order}: ${JSON.stringify(hall.map((i) => i.status))}`);
  }
});

test('striking a carried task\'s newest line cancels it; striking an older copy ends only that line', async () => {
  const mon = page(), tue = page();
  await apply(mon, result([item('Call the invented co-op'), item('Haul the invented bales')], { page_date: '2026-10-13' }));
  await apply(tue, result([item('Call the invented co-op'), item('Haul the invented bales')], { page_date: '2026-10-14' })); // carried
  await apply(tue, result([item('Call the invented co-op', { existing_item_id: byCode(1).id, status: 'dropped' }),
    item('Haul the invented bales', { existing_item_id: byCode(2).id })], { page_date: '2026-10-14' })); // struck on Tuesday
  await apply(mon, result([item('Call the invented co-op', { existing_item_id: byCode(1).id }),
    item('Haul the invented bales', { existing_item_id: byCode(2).id, status: 'dropped' })], { page_date: '2026-10-13' })); // Monday's struck as moved on
  assert.deepEqual(items().map((i) => [i.code, i.status, i.closed_by]), [[1, 'dropped', 'handwriting'], [2, 'open', null]]);
  assert.ok(db.prepare('SELECT gone_at FROM item_mentions WHERE item_id=? AND page_id=?').get(byCode(2).id, mon.id).gone_at, 'Monday\'s line ended');
  // Wednesday's line, written and struck before Wednesday was ever read, cancels it too.
  await apply(page(), result([item('Haul the invented bales', { status: 'dropped' })], { page_date: '2026-10-15' }));
  assert.equal(byCode(2).status, 'dropped');
});

test('a struck line that matches no item is nothing', async () => {
  await apply(page(), result([item('Rent the invented lift', { status: 'dropped' }), item('Rent the invented trailer')]));
  assert.deepEqual(items().map((i) => [i.text, i.status]), [['Rent the invented trailer', 'open']]);
});

test('an expired snooze carried onto a page with a ticked line is carried, not copied', async () => {
  await apply(page(), result([item('Call the invented vet')], { page_date: '2026-10-13' }));
  setItemStatus(byCode(1).id, 'snoozed', 'handwriting', null, '2000-01-01'); // its snooze is over
  await apply(page(), result([item('Call the invented vet'), item('Sweep the invented loft', { status: 'done' })], { page_date: '2026-10-15' }));
  assert.deepEqual(items().map((i) => [i.code, i.status, i.carry_days]), [[1, 'snoozed', 2], [2, 'done', 1]]);
});

test('an item reopened by hand after its line left its page isn\'t dropped again by the next read of that page', async () => {
  const p = page();
  await apply(p, result([item('Fix the invented latch'), item('Oil the invented hinge')]));
  await apply(p, result([item('Oil the invented hinge', { existing_item_id: byCode(2).id })]));
  assert.equal(byCode(1).status, 'dropped');
  setItemStatus(byCode(1).id, 'open', 'ui');
  await apply(p, result([item('Oil the invented hinge', { existing_item_id: byCode(2).id }), item('Paint the invented door')]));
  assert.deepEqual([byCode(1).status, statusEvents(1)], ['open', ['erased:open->dropped', 'ui:dropped->open']]);
});

test('a ticked line without its id is the page\'s open item with those words, not a done one already linked', async () => {
  const p = page();
  await apply(p, result([item('Check the invented bin temps', { status: 'done' })])); // last week's, ticked
  const old = byCode(1).id;
  await apply(p, result([item('Check the invented bin temps', { existing_item_id: old, status: 'done' }), item('Check the invented bin temps')]));
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'done'], [2, 'open']], 'this week\'s');
  await apply(p, result([item('Check the invented bin temps', { existing_item_id: old, status: 'done' }),
    item('check the invented bin temps.', { status: 'done' })])); // this week's ticked, read without its id
  assert.deepEqual(items().map((i) => [i.code, i.status, i.closed_by]), [[1, 'done', 'handwriting'], [2, 'done', 'handwriting']]);
});

test('a lone ticked line without its id, with an open and a done item of those words on the page, ticks the open one', async () => {
  const p = page();
  await apply(p, result([item('Check the invented bin temps', { status: 'done' }), item('Check the invented bin temps')]));
  assert.deepEqual(items().map((i) => i.status), ['done', 'open']);
  await apply(p, result([item('Check the invented bin temps', { status: 'done' })])); // one ticked line read, no id
  assert.deepEqual(items().map((i) => [i.status, i.closed_by]), [['done', 'handwriting'], ['done', 'handwriting']], 'not dropped as erased');
});

test('two ticked lines of the same words: one linked by id, the other matched in code to the other item', async () => {
  const p = page();
  await apply(p, result([item('Clean the invented gutters', { status: 'done' }), item('Clean the invented gutters', { status: 'done' })]));
  const [first, second] = items().map((i) => i.id);
  await apply(p, result([item('Clean the invented gutters', { status: 'done', existing_item_id: first }), item('Clean the invented gutters', { status: 'done' })]));
  assert.deepEqual(db.prepare('SELECT item_id FROM item_mentions WHERE page_id=? AND gone_at IS NULL ORDER BY item_id').all(p.id).map((m) => m.item_id),
    [first, second].sort(), 'both lines still on the page');
});

test('an old line of a moved item, read again ticked or struck on its old page, changes nothing', async () => {
  const q = page(), p = page();
  await apply(q, result([item('Haul the invented gravel'), item('Stay on this page')], { page_date: '2026-10-14' }));
  await apply(q, result([item('Stay on this page', { existing_item_id: byCode(2).id })], { page_date: '2026-10-14' }));
  await apply(p, result([item('Haul the invented gravel')], { page_date: '2026-10-15' })); // moved to p
  await apply(q, result([item('Stay on this page', { existing_item_id: byCode(2).id }),
    item('Haul the invented gravel', { existing_item_id: byCode(1).id, status: 'dropped' })], { page_date: '2026-10-14' }));
  assert.deepEqual([items().length, byCode(1).status], [2, 'open']);
});

test('a snoozed task written again on a page while its line is still elsewhere is a new, visible item', async () => {
  const mon = page();
  await apply(mon, result([item('Call Tom about the invented letter')], { page_date: '2026-10-13' }));
  setItemStatus(byCode(1).id, 'snoozed', 'handwriting', null, '2999-01-01');
  await apply(page(), result([item('Call Tom about the invented letter', { due_time: '2pm' })], { page_date: '2026-10-15' }));
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'snoozed'], [2, 'open']]);
});

test('an item whose snooze is over is dropped when its line is erased, like an open one', async () => {
  const p = page();
  await apply(p, result([item('Order the invented tags')]));
  setItemStatus(byCode(1).id, 'snoozed', 'handwriting', null, '2000-01-01');
  await apply(p, result([]));
  assert.deepEqual([byCode(1).status, byCode(1).closed_by], ['dropped', 'erased']);
});

test('an item a person dropped stays dropped while its line stays on the page, however long', async () => {
  const p = page();
  await apply(p, result([item('Book the invented hall')]));
  setItemStatus(byCode(1).id, 'dropped', 'ui');
  db.prepare('UPDATE items SET closed_at=? WHERE code=1').run(hoursAgo(48));
  await apply(p, result([item('Book the invented hall', { existing_item_id: byCode(1).id })]));
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'dropped']]);
});

test('a ticked line moved to another page is its done item, not a new one', async () => {
  const q = page(), p = page();
  await apply(q, result([item('Wash the invented truck', { status: 'done' }), item('Stay on this page')], { page_date: '2026-10-14' }));
  await apply(q, result([item('Stay on this page', { existing_item_id: byCode(2).id })], { page_date: '2026-10-14' })); // lassoed off
  await apply(p, result([item('Wash the invented truck', { status: 'done' })], { page_date: '2026-10-15' }));
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'done'], [2, 'open']]);
});

test('a page emptied (blank, or deleted) drops its open items with no line left elsewhere', () => {
  const p = page(), other = page();
  return (async () => {
    await apply(p, result([item('Sweep the invented shed'), item('Carried along')], { page_date: '2026-10-14' }));
    await apply(other, result([item('Carried along')], { page_date: '2026-10-15' }));
    const dropped = pageEmptied(p.id);
    assert.deepEqual(dropped, [byCode(1).id]);
    assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'dropped'], [2, 'open']]);
    assert.deepEqual(pageEmptied(p.id), [], 'and again: nothing more to drop');
  })();
});

test('a task written again on its page after its item was closed elsewhere is new, however it was closed', async () => {
  for (const close of ['ui done', 'person drop', 'moved and ticked']) {
    db.exec('DELETE FROM item_mentions; DELETE FROM items;');
    const todo = page(), mon = page();
    await apply(todo, result([item('Pay the invented rent'), item('Keep this line')]));
    if (close === 'moved and ticked') {
      await apply(todo, result([item('Keep this line', { existing_item_id: byCode(2).id })]));
      await apply(mon, result([item('Pay the invented rent')], { page_date: '2026-10-15' })); // moved…
      await apply(mon, result([item('Pay the invented rent', { existing_item_id: byCode(1).id, status: 'done' })], { page_date: '2026-10-15' })); // …and ticked there
    } else {
      await apply(todo, result([item('Keep this line', { existing_item_id: byCode(2).id })])); // erased when paid
      setItemStatus(byCode(1).id, close === 'ui done' ? 'done' : 'dropped', 'ui');
    }
    await apply(todo, result([item('Keep this line', { existing_item_id: byCode(2).id }), item('Pay the invented rent', { existing_item_id: byCode(1).id })]));
    const rent = items().filter((i) => i.text === 'Pay the invented rent').map((i) => [i.code, i.status]);
    assert.deepEqual(rent, [[1, close === 'person drop' ? 'dropped' : 'done'], [3, 'open']], `${close}: next month's rent is a new open item`);
  }
});

test('on a page with no written date, a due date written on the line still restarts the nudges', async () => {
  const p = page();
  const read = (extra) => applyPageResult(p, result([item('Renew the invented permit', extra)], { page_date: null }), '2026-10-14');
  await read({ due: '2026-10-20' });
  db.prepare(`UPDATE items SET last_nudged='2026-10-22T14:00:00Z', nudge_count=3 WHERE code=1`).run();
  await read({ due: '2026-10-27', existing_item_id: byCode(1).id });
  assert.deepEqual([byCode(1).due, byCode(1).nudge_count], ['2026-10-27', 0]);
});

test('a tick on a page an item\'s line was missed on, while it\'s carried elsewhere, closes it', async () => {
  const mon = page(), tue = page();
  await apply(mon, result([item('Call the invented co-op')], { page_date: '2026-10-13' }));
  await apply(tue, result([item('Call the invented co-op')], { page_date: '2026-10-14' })); // carried
  await apply(mon, result([], { page_date: '2026-10-13' })); // a read misses it on Monday: still open, via Tuesday
  await apply(mon, result([item('Call the invented co-op', { existing_item_id: byCode(1).id, status: 'done' })], { page_date: '2026-10-13' }));
  assert.deepEqual([items().length, byCode(1).status], [1, 'done']);
});

test('a struck line for an item a read had just missed, read again without its id, cancels it for good', async () => {
  const q = page();
  await apply(q, result([item('Order the invented brackets'), item('Keep this line')]));
  await apply(q, result([item('Keep this line', { existing_item_id: byCode(2).id })])); // missed: dropped as erased
  await apply(q, result([item('Keep this line', { existing_item_id: byCode(2).id }), item('Order the invented brackets', { status: 'dropped' })]));
  assert.deepEqual([items().length, byCode(1).status, byCode(1).closed_by], [2, 'dropped', 'handwriting']);
});

test('a snoozed item ticked off on another page is closed', async () => {
  await apply(page(), result([item('Call the invented lab')], { page_date: '2026-10-13' }));
  setItemStatus(byCode(1).id, 'snoozed', 'handwriting', null, '2999-01-01');
  await apply(page(), result([item('Call the invented lab', { status: 'done' })], { page_date: '2026-10-15' }));
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'done']]);
});

test('a ticked line on a new page ticks this week\'s open copy, not last week\'s done one just tidied away', async () => {
  const todo = page();
  await apply(todo, result([item('Send the weekly invented report', { status: 'done' })]));
  await apply(todo, result([item('Send the weekly invented report')])); // last week's ticked line erased; this week's written
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'done'], [2, 'open']]);
  await apply(page(), result([item('Send the weekly invented report', { status: 'done' })], { page_date: '2026-10-15' })); // done, logged on the daily page
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'done'], [2, 'done']]);
});

test('a ticked line read without its id, back on its page soon after a read missed it, closes its item', async () => {
  const p = page();
  await apply(p, result([item('Mend the invented fence'), item('Keep this line')]));
  await apply(p, result([item('Keep this line', { existing_item_id: byCode(2).id })])); // missed: dropped as erased
  await apply(p, result([item('Keep this line', { existing_item_id: byCode(2).id }), item('Mend the invented fence', { status: 'done' })]));
  assert.deepEqual(items().map((i) => [i.code, i.status, i.closed_by]), [[1, 'done', 'handwriting'], [2, 'open', null]]);
});

test('a ticked line for a done item whose line left the page long ago is a new done item', async () => {
  const p = page();
  await apply(p, result([item('Clean the invented gutters', { status: 'done' }), item('Keep this line')]));
  await apply(p, result([item('Keep this line', { existing_item_id: byCode(2).id })])); // the ticked line is erased
  leftAgo(1, 24 * 30);
  await apply(p, result([item('Keep this line', { existing_item_id: byCode(2).id }), item('Clean the invented gutters', { status: 'done' })]));
  assert.deepEqual(items().map((i) => [i.code, i.status]), [[1, 'done'], [2, 'open'], [3, 'done']]);
});

test('two unlinked ticked lines with the same words go to two items of the page, not one', async () => {
  const p = page();
  await apply(p, result([item('Clean the invented gutters'), item('Clean the invented gutters')]));
  assert.equal(items().length, 2);
  await apply(p, result([item('Clean the invented gutters', { status: 'done' }), item('Clean the invented gutters', { status: 'done' })]));
  assert.deepEqual(items().map((i) => i.status), ['done', 'done']);
});

test('a line for an item dropped by hand is new, however soon it\'s written', async () => {
  await apply(page(), result([item('Fill the invented sprayer')]));
  setItemStatus(byCode(1).id, 'dropped', 'ui');
  await apply(page(), result([item('Fill the invented sprayer')]));
  assert.deepEqual(items().map((i) => [i.code, i.status, i.closed_by]), [[1, 'dropped', 'ui'], [2, 'open', null]]);
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
