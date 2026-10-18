// The ledger with a registry: names resolve, a stored full name isn't replaced by its own first name, and
// person_ambiguous always describes the names stored, against the registry in use now. Registry and items are invented.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempEnv } from './helpers.js';

const dataDir = tempEnv('ledger-registry');
const registryFile = path.join(dataDir, 'projects.yaml');
fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'registry.yaml'), registryFile);
const { db, editItem } = await import('../src/db.js');
const { applyPageResult } = await import('../src/pipeline/ledger.js');
const { personAmbiguous } = await import('../src/registry.js');

let n = 0;
function page() {
  const id = `pg${++n}`;
  db.prepare('INSERT OR IGNORE INTO documents (id, name) VALUES (?, ?)').run('doc1', 'doc1');
  db.prepare(`INSERT INTO pages (id, doc_id, page_index, rm_hash, status) VALUES (?,?,?,?, 'rendered')`).run(id, 'doc1', n, `hash${n}`);
  return db.prepare('SELECT * FROM pages WHERE id=?').get(id);
}
const item = (text, extra = {}) => ({ existing_item_id: null, text, kind: 'followup', status: 'open', person: null, assignee: null,
  due: null, due_time: null, priority: false, tags: [], ...extra });
const read = (p, items, date = '2026-10-14') => applyPageResult(p, { page_date: date, summary: 's', tags: [], transcription_md: 'md',
  legibility: 'high', uncertain_spans: [], items, closes: [] }, date);
const one = () => db.prepare('SELECT * FROM items WHERE code=1').get();
const names = () => { const i = one(); return [i.person, i.assignee, personAmbiguous(i)]; };

beforeEach(() => db.exec('DELETE FROM item_mentions; DELETE FROM items; DELETE FROM pages; DELETE FROM documents;'));

test('a hand edit that resolves an ambiguous assignee clears the flag, and a re-read keeps the edit', async () => {
  const p = page();
  await read(p, [item('Ask about the numbers', { assignee: 'Alex' })]);
  assert.deepEqual(names(), [null, 'Alex', true]);
  editItem(one().id, { assignee: 'Alex T' }, 'ui');
  assert.deepEqual(names(), [null, 'Alex Two', false], 'the edit resolves through write_as');
  await read(p, [item('Ask about the numbers', { existing_item_id: one().id, assignee: 'Pat' })]);
  assert.deepEqual(names(), [null, 'Alex Two', false], 'the hand edit outlasts a re-read naming someone else');
});

for (const field of ['person', 'assignee']) {
  const at = (v) => (field === 'person' ? [v, null] : [null, v]);

  test(`${field}: a re-read never replaces a resolved full name with its first name`, async () => {
    const p = page();
    await read(p, [item('Ask about the numbers', { [field]: 'Alex T' })]);
    assert.deepEqual(names(), [...at('Alex Two'), false]);
    await read(p, [item('Ask about the numbers', { existing_item_id: one().id, [field]: 'Alex' })]);
    assert.deepEqual(names(), [...at('Alex Two'), false]);
  });

  test(`${field}: a carried rewrite with just the first name keeps the full name too`, async () => {
    await read(page(), [item('Ask about the numbers', { [field]: 'Alex O' })], '2026-10-13');
    await read(page(), [item('Ask about the numbers', { [field]: 'Alex' })], '2026-10-15'); // matched by dedupe (same text)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 1);
    assert.deepEqual(names(), [...at('Alex One'), false]);
    assert.equal(one().carry_days, 2);
  });

  test(`${field}: another person's name replaces the stored one, even an ambiguous first name`, async () => {
    const p = page();
    await read(p, [item('Ask about the numbers', { [field]: 'Pat' })]);
    assert.deepEqual(names(), [...at('Pat Example'), false]);
    await read(p, [item('Ask about the numbers', { existing_item_id: one().id, [field]: 'Alex' })]);
    assert.deepEqual(names(), [...at('Alex'), true], 'the page now names an Alex, so the item does too, flagged');
    await read(p, [item('Ask about the numbers', { existing_item_id: one().id, [field]: 'Jordan' })]);
    assert.deepEqual(names(), [...at('Jordan'), false]);
  });
}

test('a name stored before the registry (a write_as form, another case) keeps its person when re-read by first name', async () => {
  const text = fs.readFileSync(registryFile, 'utf8');
  const totalsPage = page();
  fs.rmSync(registryFile);
  try {
    await read(page(), [item('Ask about the numbers', { person: 'Alex T' })], '2026-10-13');
    await read(totalsPage, [item('Check the totals', { assignee: 'alex two' })], '2026-10-13');
  } finally { fs.writeFileSync(registryFile, text); }
  await read(page(), [item('Ask about the numbers', { person: 'Alex' })], '2026-10-15'); // carried: same text
  const totals = () => db.prepare(`SELECT * FROM items WHERE text='Check the totals'`).get();
  await read(totalsPage, [item('Check the totals', { existing_item_id: totals().id, assignee: 'Alex' })], '2026-10-13');
  assert.deepEqual(names(), ['Alex Two', null, false], 'resolved to the full name, not replaced');
  assert.deepEqual([totals().assignee, personAmbiguous(totals())], ['Alex Two', false]);
});

test('a unique first name never replaces the full name it belongs to', async () => {
  const p = page();
  await read(p, [item('Send the agenda', { person: 'RF' })]);
  assert.deepEqual(names(), ['Robin Fixture', null, false]);
  await read(p, [item('Send the agenda', { existing_item_id: one().id, person: 'Robin' })]);
  assert.deepEqual(names(), ['Robin Fixture', null, false]);
});

test('a partial re-read keeps the stored ambiguous name, still flagged', async () => {
  const p = page();
  await read(p, [item('Ask about the numbers', { person: 'Alex' })]);
  assert.deepEqual(names(), ['Alex', null, true]);
  await read(p, [item('Ask about the numbers', { existing_item_id: one().id, person: null, assignee: 'Sam' })]);
  assert.deepEqual(names(), ['Alex', 'Sam Fixture', true], 'person kept from before, still ambiguous');
});

test('editing one name leaves the flag on the other ambiguous name', async () => {
  await read(page(), [item('Ask about the numbers', { person: 'Alex' })]);
  editItem(one().id, { assignee: 'Sam' }, 'ui');
  assert.deepEqual(names(), ['Alex', 'Sam Fixture', true]);
  editItem(one().id, { assignee: null }, 'ui');
  assert.deepEqual(names(), ['Alex', null, true]);
  editItem(one().id, { person: 'Alex O' }, 'ui');
  assert.deepEqual(names(), ['Alex One', null, false]);
});

test('person can be edited by hand; it resolves, is recorded, and survives a re-read', async () => {
  const p = page();
  await read(p, [item('Ask about the numbers', { person: 'Alex' })]);
  assert.deepEqual(editItem(one().id, { person: 'Pat' }, 'ui'), ['person']);
  assert.deepEqual(names(), ['Pat Example', null, false]);
  assert.deepEqual(JSON.parse(one().edited), ['person']);
  await read(p, [item('Ask about the numbers', { existing_item_id: one().id, person: 'Alex' })]);
  assert.deepEqual(names(), ['Pat Example', null, false]);
});

test('the flag follows the registry in use: none, one that lists two Alexes, and none again', async () => {
  const text = fs.readFileSync(registryFile, 'utf8');
  try {
    fs.rmSync(registryFile);
    await read(page(), [item('Ask about the numbers', { person: 'Alex' })]); // read before there was a registry
    assert.deepEqual(names(), ['Alex', null, false], 'without a registry nothing is ambiguous');
    fs.writeFileSync(registryFile, text);
    assert.deepEqual(names(), ['Alex', null, true], 'an older item is flagged once the registry lists two Alexes');
    fs.writeFileSync(registryFile, text.replace('  - name: Alex Two\n    write_as: [Alex T]\n', ''));
    assert.deepEqual(names(), ['Alex', null, false], 'one Alex left: the first name is no longer shared');
  } finally {
    fs.writeFileSync(registryFile, text);
  }
});
