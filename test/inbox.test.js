// Step 3 acceptance (spec §1.4): API clients create items through POST /api/items, checked against the open loops
// first. The same source_ref twice is one item; a near-duplicate is merged into the open item (the fake Haiku matches
// it); a request that outlasts the time budget is queued and still created; a dry run writes nothing; an email's item
// later written on a page keeps source=email and isn't dropped when its line is erased. Real SDK against the fake API.
// All content is invented.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempEnv } from './helpers.js';
import { fakeAnthropic } from './fakes/anthropic.js';

const userText = (params) => {
  const c = params.messages[0].content;
  return typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
};
// The fake Haiku matches a new item to the open item whose words overlap it most (over half), as a real model might
// match a reworded task. delayMs holds its answer back; garbled makes it answer with something that isn't JSON;
// whileDeduping runs once while a call is out (another writer acting meanwhile).
let delayMs = 0, garbled = false, whileDeduping = null;
const dedupes = [];
function dedupe(params) {
  const text = userText(params);
  dedupes.push(text);
  const words = (t) => new Set(t.toLowerCase().split(/\W+/).filter(Boolean));
  const near = (a, b) => [...words(a)].filter((w) => words(b).has(w)).length / Math.max(words(a).size, words(b).size);
  const news = [...text.matchAll(/^NEW (\S+): (.+?)( \(ticked\))?$/gm)].map((m) => ({ ref: m[1], t: m[2] }));
  const olds = [...text.matchAll(/^OPEN (\d+): (.+)$/gm)].map((m) => ({ code: Number(m[1]), t: m[2] }));
  return { matches: news.flatMap((n) => {
    const best = olds.filter((o) => near(o.t, n.t) > 0.5).sort((a, b) => near(b.t, n.t) - near(a.t, n.t))[0];
    return best ? [{ new_ref: n.ref, code: best.code }] : [];
  }) };
}
const fake = await fakeAnthropic(async (params, purpose) => {
  if (purpose !== 'dedupe') throw new Error(`unexpected ${purpose} call`);
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  if (whileDeduping) { const act = whileDeduping; whileDeduping = null; await act(); }
  return garbled ? 'not json' : dedupe(params);
});
const dataDir = tempEnv('inbox', { GLEANER_PORT: '0', GLEANER_LLM: 'live', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: fake.url });
fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'registry.yaml'), path.join(dataDir, 'projects.yaml'));

const { db } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { applyPageResult, dropErasedSnoozes } = await import('../src/pipeline/ledger.js');
const { setItemStatus, editItem } = await import('../src/db.js');
const { startServer } = await import('../src/server.js');
const { addToken } = await import('../src/auth.js');
const inbox = await import('../src/adapters/api-inbox.js');

const server = startServer();
await new Promise((r) => server.once('listening', r));
after(() => { server.close(); db.close(); fake.close(); });
const base = `http://127.0.0.1:${server.address().port}`;
const artifact = addToken('artifact', { scopes: 'read,write,create', sensitivity: 'all' });
const reader = addToken('reader', { scopes: 'read', sensitivity: 'all' });
const cowork = addToken('cowork', { scopes: 'read,create', sensitivity: 'normal' });
const create = async (body, { token = artifact, query = '' } = {}) => {
  const res = await fetch(`${base}/api/items${query}`, { method: 'POST', body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  return { status: res.status, body: await res.json() };
};

let n = 0;
function page(tags = []) {
  const id = `pg${++n}`;
  db.prepare('INSERT OR IGNORE INTO documents (id, name) VALUES (?, ?)').run('doc1', 'Field notes');
  db.prepare(`INSERT INTO pages (id, doc_id, page_index, rm_hash, status) VALUES (?,?,?,?, 'rendered')`).run(id, 'doc1', n, `hash${n}`);
  const row = db.prepare('SELECT * FROM pages WHERE id=?').get(id);
  return { row, read: (items, pageTags = tags) => applyPageResult(row, { page_date: '2026-10-20', summary: 's', tags: pageTags, transcription_md: 'md', legibility: 'high',
    uncertain_spans: [], closes: [], items: items.map((i) => ({ existing_item_id: null, kind: 'action', status: 'open', person: null, assignee: null,
      due: null, due_time: null, priority: false, tags: [], ...i })) }, '2026-10-20') };
}
const byCode = (code) => db.prepare('SELECT * FROM items WHERE code=?').get(code);
const count = (sql, ...a) => db.prepare(sql).get(...a).n;
const settled = async (inboxId) => {
  for (let i = 0; i < 100; i++) {
    const row = db.prepare('SELECT status FROM inbox WHERE id=?').get(inboxId);
    if (row.status !== 'pending') return row.status;
    await new Promise((r) => setTimeout(r, 20));
  }
  return 'pending';
};

test('an item created through the API is open, with its fields, source and client', async () => {
  const res = await create({ text: 'Book the invented hall', due: '2026-10-23', due_time: '2pm', assignee: 'Pat', tags: ['wr'], priority: true,
    kind: 'followup', source: 'artifact' });
  assert.equal(res.status, 201);
  assert.equal(res.body.result, 'created');
  const it = byCode(res.body.code);
  assert.deepEqual([it.status, it.source, it.source_ref, it.due, it.due_time, it.priority, it.kind, it.tags],
    ['open', 'artifact', null, '2026-10-23', '14:00', 1, 'followup', '["widget-report"]']);
  assert.equal(res.body.item.text, 'Book the invented hall');
  assert.deepEqual(db.prepare('SELECT client, field, new FROM events WHERE item_code=?').all(res.body.code),
    [{ client: 'artifact', field: 'created', new: 'Book the invented hall' }]);
  const open = await (await fetch(`${base}/api/items`, { headers: { Authorization: `Bearer ${reader}` } })).json();
  assert.ok(open.some((i) => i.code === res.body.code));
});

test('the same source and source_ref sent twice is one item', async () => {
  const first = await create({ text: 'Reply to the invented vendor', source: 'email', source_ref: 'msg-1' });
  const calls = dedupes.length;
  const again = await create({ text: 'Reply to the invented vendor, reworded', source: 'email', source_ref: 'msg-1' });
  assert.equal(dedupes.length, calls, 'known by its source_ref, before any dedupe call');
  assert.deepEqual([first.status, first.body.result, again.status, again.body.result, again.body.code], [201, 'created', 200, 'existing', first.body.code]);
  assert.equal(count(`SELECT COUNT(*) AS n FROM items WHERE source_ref='msg-1'`), 1);
  const other = await create({ text: 'Reply to the invented vendor', source: 'calendar', source_ref: 'msg-1' });
  assert.equal(other.body.result, 'merged', 'another source\'s id is another item, but this one is open with those words');
});

test('a near-duplicate of an open item is merged into it, filling only what the item lacks', async () => {
  const p = page();
  await p.read([{ text: 'Send Pat the invented widget draft', due: '2026-10-22', tags: ['bp'] }]);
  const open = db.prepare(`SELECT * FROM items WHERE text='Send Pat the invented widget draft'`).get();
  const res = await create({ text: 'Send Pat the invented widget draft today', due: '2026-10-30', assignee: 'Pat', tags: ['gizmo'] });
  assert.deepEqual([res.status, res.body.result, res.body.code], [200, 'merged', open.code]);
  const it = byCode(open.code);
  assert.deepEqual([it.text, it.due, it.source, it.tags], ['Send Pat the invented widget draft', '2026-10-22', 'handwriting', '["bridge-permit","widget-report"]'],
    'its text, due date, source and tags stay; the new tag is added');
  assert.ok(it.assignee, 'an empty field is filled');
  assert.deepEqual(db.prepare(`SELECT client, field FROM events WHERE item_code=? AND client='artifact' ORDER BY id`).all(open.code).map((e) => e.field),
    ['assignee', 'tags']);
});

test('a request that outlasts the time budget is queued, then created; one that fails is applied at the next ingest', async () => {
  const budget = config.api.createBudgetSeconds;
  config.api.createBudgetSeconds = 0.05;
  delayMs = 400;
  try {
    const res = await create({ text: 'Order the invented gaskets' });
    assert.deepEqual([res.status, res.body.result], [202, 'queued']);
    assert.equal(await settled(res.body.inbox_id), 'done');
    assert.equal(count(`SELECT COUNT(*) AS n FROM items WHERE text='Order the invented gaskets' AND status='open'`), 1);
  } finally { config.api.createBudgetSeconds = budget; delayMs = 0; }

  garbled = true;
  let queued;
  try {
    queued = await create({ text: 'Mail the invented invoices' });
    assert.deepEqual([queued.status, queued.body.result], [202, 'queued']);
    assert.equal(await settled(queued.body.inbox_id), 'failed');
    assert.equal(count(`SELECT COUNT(*) AS n FROM items WHERE text='Mail the invented invoices'`), 0);
  } finally { garbled = false; }
  const applied = await inbox.drain();
  assert.deepEqual(applied, [db.prepare(`SELECT id FROM items WHERE text='Mail the invented invoices'`).get().id], 'the items it changed, for their day files');
  assert.deepEqual(await inbox.drain(), [], 'and only once');
  // An outage longer than a few ingests: still retried, for a week.
  garbled = true;
  try { await create({ text: 'Weigh the invented bales' }); } finally { garbled = false; }
  db.prepare(`UPDATE inbox SET attempts=9 WHERE status='failed'`).run();
  const old = await (async () => { garbled = true; try { return await create({ text: 'Sweep the invented loft' }); } finally { garbled = false; } })();
  db.prepare('UPDATE inbox SET at=? WHERE id=?').run(new Date(Date.now() - 8 * 864e5).toISOString(), old.body.inbox_id);
  assert.equal((await inbox.drain()).length, 1, 'tried many times: applied; a week old: left as failed');
  assert.equal(count(`SELECT COUNT(*) AS n FROM items WHERE text='Sweep the invented loft'`), 0);
});

test('a dry run writes nothing, and says what would happen', async () => {
  const before = ['items', 'events', 'inbox'].map((t) => count(`SELECT COUNT(*) AS n FROM ${t}`));
  const fresh = await create({ text: 'Paint the invented barn' }, { query: '?dry_run=1' });
  const dup = await create({ text: 'Send Pat the invented widget draft again' }, { query: '?dry_run=1' });
  assert.deepEqual([fresh.status, fresh.body.result, dup.body.result], [200, 'would_create', 'would_merge']);
  assert.equal(dup.body.code, db.prepare(`SELECT code FROM items WHERE text='Send Pat the invented widget draft'`).get().code);
  assert.deepEqual(['items', 'events', 'inbox'].map((t) => count(`SELECT COUNT(*) AS n FROM ${t}`)), before);
});

test('an email\'s item later written on a page keeps source=email, and isn\'t dropped when its line is erased', async () => {
  const res = await create({ text: 'Call the invented co-op about seed', source: 'email', source_ref: 'msg-9' });
  const p = page();
  await p.read([{ text: 'Call the invented co-op about seed' }]); // written down: the dedupe matches it
  const it = () => byCode(res.body.code);
  assert.equal(count('SELECT COUNT(*) AS n FROM item_mentions WHERE item_id=?', it().id), 1);
  await p.read([]); // erased from the page
  assert.deepEqual([it().status, it().source], ['open', 'email']);
  setItemStatus(it().id, 'snoozed', 'artifact', null, '2026-10-01'); // and once a snooze of it is over
  assert.deepEqual(dropErasedSnoozes('2026-10-02'), []);
  assert.equal(it().status, 'snoozed');
});

test('a client that may not see restricted work creates a new item instead of merging into one', async () => {
  const moon = page(['moonbase']);
  await moon.read([{ text: 'Order the invented regolith crates' }]);
  const hidden = db.prepare(`SELECT code FROM items WHERE text='Order the invented regolith crates'`).get().code;
  const dry = await create({ text: 'Order the invented regolith crates' }, { token: cowork, query: '?dry_run=1' });
  assert.equal(dry.body.result, 'would_create');
  const res = await create({ text: 'Order the invented regolith crates' }, { token: cowork });
  assert.equal(res.body.result, 'created');
  assert.notEqual(res.body.code, hidden);
  assert.equal(byCode(hidden).tags, '[]', 'the hidden item is untouched');
});

test('a request merged into an item is that item for good: sent again, even after it is closed, it is "existing"', async () => {
  const p = page();
  await p.read([{ text: 'Reply to the invented co-op about pallets' }]);
  const it = db.prepare(`SELECT * FROM items WHERE text='Reply to the invented co-op about pallets'`).get();
  const msg = { text: 'Reply to the invented co-op about pallets', source: 'email', source_ref: 'msg-pallets' };
  assert.deepEqual([(await create(msg)).body.result], ['merged']);
  const calls = dedupes.length;
  assert.deepEqual([(await create(msg)).body.result, dedupes.length], ['existing', calls], 'no second dedupe call');
  setItemStatus(it.id, 'done', 'ui');
  const again = await create(msg);
  assert.deepEqual([again.body.result, again.body.code], ['existing', it.code]);
  assert.equal(count(`SELECT COUNT(*) AS n FROM items WHERE text='Reply to the invented co-op about pallets'`), 1, 'the finished task doesn\'t come back');
  assert.equal((await create(msg, { query: '?dry_run=1' })).body.result, 'existing');
});

test('a merge keeps what Matt set or cleared by hand, and its tags survive a re-read of the page', async () => {
  const p = page();
  await p.read([{ text: 'Fix the invented gate latch', assignee: 'Pat', due: '2026-10-22' }]);
  const it = db.prepare(`SELECT * FROM items WHERE text='Fix the invented gate latch'`).get();
  editItem(it.id, { assignee: null, due: null }, 'ui'); // it's his, with no date
  const res = await create({ text: 'Fix the invented gate latch', assignee: 'Pat', due: '2026-10-30', tags: ['budget'] });
  assert.equal(res.body.result, 'merged');
  const after = byCode(it.code);
  assert.deepEqual([after.assignee, after.due, after.tags], [null, null, '["budget"]'], 'the hand edits stay; the tag is added');
  await p.read([{ text: 'Fix the invented gate latch', existing_item_id: it.id }, { text: 'Oil the invented hinge' }]); // more ink: read again
  assert.equal(byCode(it.code).tags, '["budget"]', 'the line has no tag, but the one a client gave stays');
  const email = await create({ text: 'Order the invented fence posts', tags: ['wr'], source: 'email' });
  const q = page();
  await q.read([{ text: 'Order the invented fence posts', tags: ['bp'] }]); // written down, with a tag of its own
  assert.equal(byCode(email.body.code).tags, '["bridge-permit","widget-report"]');
});

test('an item closed while the dedupe call is out isn\'t merged into: the request makes a new item', async () => {
  const p = page();
  await p.read([{ text: 'Order the invented pump gaskets' }]);
  const it = db.prepare(`SELECT * FROM items WHERE text='Order the invented pump gaskets'`).get();
  whileDeduping = () => setItemStatus(it.id, 'done', 'ui');
  const res = await create({ text: 'Order the invented pump gaskets' });
  assert.equal(res.body.result, 'created');
  assert.deepEqual([byCode(it.code).status, byCode(res.body.code).status], ['done', 'open']);
});

test('a normal client: what it may not see is judged when its turn comes, and a hidden item\'s number is never returned', async () => {
  // A page is being read, and makes an open item restricted, while the client's request waits its turn.
  const p = page();
  await p.read([{ text: 'Price the invented rover tyres' }]);
  const it = db.prepare(`SELECT * FROM items WHERE text='Price the invented rover tyres'`).get();
  delayMs = 300;
  let reading;
  try {
    reading = p.read([{ text: 'Price the invented rover tyres', existing_item_id: it.id }, { text: 'Count the invented crates' }], ['moonbase']);
    await new Promise((r) => setTimeout(r, 50)); // the page has its turn, and its dedupe call is out
    const res = await create({ text: 'Price the invented rover tyres' }, { token: cowork });
    assert.equal(res.body.result, 'created', 'not merged into an item that became restricted while it waited');
  } finally { delayMs = 0; await reading; }
  // A source_ref another client used for restricted work: "existing", without the number.
  const moon = await create({ text: 'Survey the invented crater rim', tags: ['moonbase'], source: 'email', source_ref: 'msg-crater' });
  const res = await create({ text: 'anything', source: 'email', source_ref: 'msg-crater' }, { token: cowork });
  assert.deepEqual([res.body.result, 'code' in res.body, 'item' in res.body], ['existing', false, false]);
  assert.equal((await create({ text: 'anything', source: 'email', source_ref: 'msg-crater' }, { token: cowork, query: '?dry_run=1' })).body.code, undefined);
  assert.ok(moon.body.code, 'the client that may see it gets its number');
});

test('bad requests are refused, and creating needs the create scope', async () => {
  for (const body of [{}, { text: ' ' }, { text: 'x', due: '2026-02-31' }, { text: 'x', due_time: 'noonish' }, { text: 'x', tags: 'wr' },
    { text: 'x', source: 'handwriting' }, { text: 'x', source: 'Email!' }, { text: 'x', kind: 'chore' }, { text: 'x', priority: 'yes' }]) {
    assert.equal((await create(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await create({ text: 'Rake the invented leaves' }, { token: reader })).status, 403);
});
