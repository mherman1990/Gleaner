// Step 7 acceptance: the local MCP server (gleaner-mcp/server.mjs) speaks MCP over stdio, lists one tool per ledger
// action with a JSON schema, and turns each call into a call to Gleaner's API with its own token, so changes are
// recorded under that client. Errors come back as isError results Claude can show, never as a crash. Also the
// Claude Desktop extension: its manifest matches the server, and the packed .mcpb has both at its root.
// The server runs as a real child process against a test Gleaner server. All content is invented.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempEnv } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'gleaner-mcp', 'server.mjs');
tempEnv('mcp', { GLEANER_PORT: '0' });
const { db } = await import('../src/db.js');
const { startServer } = await import('../src/server.js');
const { addToken } = await import('../src/auth.js');
const { VERSION, TOOLS } = await import('../gleaner-mcp/server.mjs');
const { packMcpb } = await import('../scripts/pack-mcpb.mjs');
const AdmZip = (await import('adm-zip')).default;

const gleaner = startServer();
await new Promise((r) => gleaner.once('listening', r));
const base = `http://127.0.0.1:${gleaner.address().port}`;
const home = addToken('claude-home', { scopes: 'read,write,create', sensitivity: 'all' });
const reader = addToken('reader', { scopes: 'read', sensitivity: 'all' });

/** A running gleaner-mcp: send(msg) writes one line; rpc(method, params) awaits the answer to its id. */
function mcp(env) {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    lines.push(msg);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  let next = 0;
  const send = (msg) => child.stdin.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`);
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++next;
    waiting.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return { child, send, rpc, call, lines, close: () => child.kill() };
}
const client = mcp({ GLEANER_URL: `${base}/`, GLEANER_TOKEN: home });
after(() => { client.close(); gleaner.close(); db.close(); });
const payload = (r) => r.structuredContent;

test('initialize, then tools/list: one tool per ledger action, each with a JSON schema and a read or write hint', async () => {
  const init = (await client.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result;
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.deepEqual([init.serverInfo.name, init.serverInfo.version, !!init.capabilities.tools], ['gleaner', VERSION, true]);
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const newer = (await client.rpc('initialize', { protocolVersion: '2099-01-01' })).result;
  assert.equal(newer.protocolVersion, '2025-11-25', 'an unknown version gets the newest this server speaks');

  const { tools } = (await client.rpc('tools/list')).result;
  assert.deepEqual(tools.map((t) => t.name), ['list_items', 'get_item', 'create_item', 'update_item', 'open_loops', 'get_notes', 'search_notes', 'list_events']);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(typeof t.description, 'string');
    assert.equal(t.annotations.readOnlyHint, !['create_item', 'update_item'].includes(t.name), `${t.name}: read-only hint`);
  }
});

test('add an item, list it, tick it off, reopen it, snooze it, edit it: each is recorded under the token\'s client', async () => {
  const created = payload(await client.call('create_item', { text: 'Book the invented hall', due: '2026-10-23', tags: ['events'], source: 'artifact' }));
  assert.equal(created.result, 'created');
  const code = created.code;
  assert.deepEqual([created.item.text, created.item.status, created.item.source], ['Book the invented hall', 'open', 'artifact']);
  assert.ok(payload(await client.call('list_items', {})).items.some((i) => i.code === code));

  assert.equal(payload(await client.call('update_item', { code, status: 'done' })).item.status, 'done');
  assert.ok(payload(await client.call('list_items', { status: 'closed' })).items.some((i) => i.code === code));
  assert.equal(payload(await client.call('update_item', { code, status: 'open' })).item.status, 'open');
  const snoozed = payload(await client.call('update_item', { code, status: 'snoozed', until: '2999-01-01' })).item;
  assert.deepEqual([snoozed.status, snoozed.snooze_until], ['snoozed', '2999-01-01']);
  const edited = payload(await client.call('update_item', { code, text: 'Book the invented hall for Friday', due: null }));
  assert.deepEqual([edited.item.text, edited.item.due], ['Book the invented hall for Friday', null]);
  assert.equal(payload(await client.call('get_item', { code })).item.text, 'Book the invented hall for Friday');

  const dry = payload(await client.call('create_item', { text: 'Paint the invented barn', dry_run: true }));
  assert.equal(dry.result, 'would_create');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM items WHERE text='Paint the invented barn'`).get().n, 0);

  const clients = new Set(db.prepare('SELECT client FROM events WHERE item_code=?').all(code).map((e) => e.client));
  assert.deepEqual([...clients], ['claude-home']);
  const events = payload(await client.call('list_events', { since: '2000-01-01', client: 'claude-home' }));
  assert.ok(events.events.some((e) => e.item_code === code && e.field === 'created'));
  assert.equal(events.more, false);
});

test('the read tools: open loops, notes and search', async () => {
  assert.match(payload(await client.call('open_loops', {})).markdown, /Book the invented hall|open/i);
  assert.deepEqual(payload(await client.call('get_notes', { date: '2001-01-01' })), { markdown: '', note: 'No notes for that day.' });
  assert.ok(Array.isArray(payload(await client.call('search_notes', { q: 'invented' })).pages));
});

test('errors come back as results Claude can show', async () => {
  const err = async (name, args, re, c = client) => {
    const r = await c.call(name, args);
    assert.equal(r.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(r.content[0].text, re);
  };
  await err('update_item', { code: 1, status: 'snoozed' }, /until/);
  await err('update_item', { code: 1 }, /status and\/or a field/);
  await err('update_item', { code: '1', status: 'done' }, /code must be integer/);
  await err('list_items', { status: 'someday' }, /must be one of/);
  await err('get_item', { code: 1, extra: true }, /unknown argument extra/);
  await err('create_item', {}, /text is required/);
  await err('create_item', { text: 'x', due: 'Friday' }, /YYYY-MM-DD/);
  await err('get_item', { code: 99999 }, /Not found/);
  const ro = mcp({ GLEANER_URL: base, GLEANER_TOKEN: reader });
  const away = mcp({ GLEANER_URL: 'http://127.0.0.1:1', GLEANER_TOKEN: home });
  const unset = mcp({ GLEANER_TOKEN: home });
  try {
    await err('create_item', { text: 'Rake the invented leaves' }, /isn't allowed.*403/, ro);
    await err('list_items', {}, /Can't reach Gleaner at http:\/\/127\.0\.0\.1:1/, away);
    await err('list_items', {}, /address isn't set/, unset);
  } finally { ro.close(); away.close(); unset.close(); }
});

test('JSON-RPC errors: unknown tool or method, bad JSON; notifications get no answer', async () => {
  assert.equal((await client.rpc('tools/call', { name: 'delete_everything', arguments: {} })).error.code, -32602);
  assert.equal((await client.rpc('resources/list')).error.code, -32601);
  assert.equal((await client.rpc('ping')).result && true, true);
  const before = client.lines.length;
  client.send('{not json');
  client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} });
  await client.rpc('ping');
  const extra = client.lines.slice(before);
  assert.deepEqual(extra.map((m) => m.error?.code ?? 'ok'), [-32700, 'ok'], 'one parse error, then the ping; nothing for the notification');
});

test('the extension\'s manifest matches the server, and the packed bundle holds both at its root', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'gleaner-mcp', 'manifest.json'), 'utf8'));
  for (const k of ['manifest_version', 'name', 'version', 'description', 'author', 'server']) assert.ok(manifest[k], k);
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.server.entry_point, 'server.mjs');
  assert.deepEqual(manifest.server.mcp_config.args, ['${__dirname}/server.mjs']);
  assert.deepEqual(manifest.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  for (const v of Object.values(manifest.server.mcp_config.env)) {
    assert.ok(manifest.user_config[v.match(/^\$\{user_config\.(\w+)\}$/)[1]], v);
  }
  const out = packMcpb(fs.mkdtempSync(path.join(os.tmpdir(), 'gleaner-mcpb-')));
  assert.match(path.basename(out), new RegExp(`^gleaner-${VERSION}\\.mcpb$`));
  const zip = new AdmZip(out);
  assert.deepEqual(zip.getEntries().map((e) => e.entryName).sort(), ['README.md', 'manifest.json', 'server.mjs']);
});
