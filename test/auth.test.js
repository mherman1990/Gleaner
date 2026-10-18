// Per-client tokens: only hashes are stored, scopes gate routes (403), unknown tokens get 401, the legacy env token
// still works as client "legacy", a new or revoked token takes effect without a restart, and the CLI prints a token
// once. Tokens and clients here are invented.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempEnv } from './helpers.js';

const dataDir = tempEnv('auth', { GLEANER_PORT: '0', GLEANER_API_TOKEN: 'legacy-secret' });
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'registry.yaml'), path.join(dataDir, 'projects.yaml'));
const tokensFile = path.join(dataDir, 'tokens.json');

const { config } = await import('../src/config.js');
const { db } = await import('../src/db.js');
const auth = await import('../src/auth.js');
const { startServer } = await import('../src/server.js');

db.prepare(`INSERT INTO items (id, code, text, kind, tags, status) VALUES ('it_a', 1, 'Send the invented agenda', 'action', '[]', 'open')`).run();
const server = startServer();
await new Promise((r) => server.once('listening', r));
after(() => { server.close(); db.close(); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = (url, token, init = {}) => fetch(base + url, { ...init,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...init.headers } });
const post = (url, token, body) => call(url, token, { method: 'POST', body: JSON.stringify(body) });

test('a token is shown once and only its hash is stored, in a file only the owner can read', () => {
  const token = auth.addToken('mayer', { scopes: 'all', sensitivity: 'all' });
  assert.match(token, /^gl_[A-Za-z0-9_-]{43}$/);
  const text = fs.readFileSync(tokensFile, 'utf8');
  assert.ok(!text.includes(token) && !text.includes(token.slice(3)), 'the token itself is never written');
  const [entry] = JSON.parse(text);
  assert.deepEqual([entry.client, entry.scopes, entry.sensitivity], ['mayer', ['read', 'write', 'create', 'ingest', 'digest'], 'all']);
  assert.match(entry.hash, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(tokensFile).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(auth.tokenStatus()).includes(entry.hash), false, 'list and doctor never show a hash');
  assert.deepEqual(auth.authenticate(`Bearer ${token}`), { client: 'mayer', scopes: entry.scopes, sensitivity: 'all' });
});

test('names, scopes and sensitivities are checked; a client has one token at a time', () => {
  assert.throws(() => auth.addToken('mayer', { scopes: 'read' }), /already has a token/);
  for (const reserved of ['ui', 'cli', 'handwriting', 'erased', 'legacy', 'api']) assert.throws(() => auth.addToken(reserved, { scopes: 'read' }), /reserved/);
  assert.throws(() => auth.addToken('Bad Name', { scopes: 'read' }), /lowercase/);
  assert.throws(() => auth.addToken('x', { scopes: 'read,delete' }), /scopes/);
  assert.throws(() => auth.addToken('x', { scopes: '' }), /scopes/);
  assert.throws(() => auth.addToken('x', { scopes: 'read', sensitivity: 'secret' }), /sensitivity/);
  auth.addToken('cowork-notebook', { scopes: 'read' });
  assert.equal(auth.tokenStatus().clients.find((c) => c.client === 'cowork-notebook').sensitivity, 'normal', 'normal unless asked');
});

test('scopes gate each route: 403 without one, 401 for an unknown token', async () => {
  const reader = auth.addToken('reader', { scopes: 'read', sensitivity: 'all' });
  const writer = auth.addToken('writer', { scopes: 'write', sensitivity: 'all' });
  assert.equal((await call('/api/items', reader)).status, 200);
  assert.equal((await post('/api/items/1', reader, { status: 'done' })).status, 403);
  assert.equal((await post('/api/ingest', reader, {})).status, 403);
  assert.equal((await post('/api/digest', reader, {})).status, 403);
  assert.equal((await call('/api/items', writer)).status, 403);
  assert.equal((await call('/api/events', writer)).status, 403);
  assert.equal((await post('/api/items/1', writer, { due: '2026-10-30' })).status, 200);
  assert.equal(db.prepare('SELECT status FROM items WHERE code=1').get().status, 'open', 'the refused close changed nothing');
  assert.equal((await call('/api/items', 'gl_not-a-real-token')).status, 401);
  assert.equal((await call('/api/items')).status, 401);
  assert.equal((await call('/api/items', null, { headers: { Authorization: `Basic ${reader}` } })).status, 401);
});

test('the legacy env token still works, as client "legacy" with every scope', async () => {
  const res = await post('/api/items/1', 'legacy-secret', { status: 'done' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).closed_by, 'legacy');
  assert.equal((await post('/api/items/1', 'legacy-secret', { status: 'open' })).status, 200);
});

test('a token added or revoked by another process takes effect without a restart', async () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'token', ...args],
    { encoding: 'utf8', env: { ...process.env, GLEANER_DATA_DIR: dataDir } });
  const added = run('add', 'mcp', '--scopes', 'read,write', '--sensitivity', 'all');
  assert.equal(added.status, 0, added.stderr);
  const token = added.stdout.match(/gl_\S+/)[0];
  assert.match(added.stdout, /shown once/);
  assert.equal((await call('/api/items', token)).status, 200);
  const list = run('list');
  assert.match(list.stdout, /^mcp\tread,write\tall\t/m);
  assert.ok(!list.stdout.includes(token) && !/[0-9a-f]{64}/.test(list.stdout), 'list shows no token or hash');
  assert.match(list.stdout, /^legacy\tall\tall\t\(GLEANER_API_TOKEN\)$/m);
  assert.equal(run('revoke', 'mcp').status, 0);
  assert.equal((await call('/api/items', token)).status, 401);
  assert.match(run('revoke', 'mcp').stdout, /has no token/);
});

test('a damaged tokens.json shuts its tokens out (closed), and can\'t be overwritten by mistake', async () => {
  const reader = auth.addToken('second-reader', { scopes: 'read', sensitivity: 'all' });
  const good = fs.readFileSync(tokensFile, 'utf8');
  fs.writeFileSync(tokensFile, good.replace(/"sensitivity": "all"/, '"sensitivity": "everything"'));
  try {
    assert.equal((await call('/api/items', reader)).status, 401);
    assert.match(auth.tokenStatus().error, /malformed/);
    assert.throws(() => auth.addToken('third', { scopes: 'read' }), /can't be read/);
    assert.equal((await call('/api/items', 'legacy-secret')).status, 200, 'the legacy token is separate');
  } finally { fs.writeFileSync(tokensFile, good); }
  assert.equal((await call('/api/items', reader)).status, 200);
});

test('with no tokens at all, /api is closed (503), not open', async () => {
  const good = fs.readFileSync(tokensFile, 'utf8');
  const legacy = config.server.apiToken;
  fs.rmSync(tokensFile);
  config.server.apiToken = '';
  try {
    assert.equal((await call('/api/items', 'anything')).status, 503);
    assert.equal((await fetch(`${base}/ui/api/items`)).status, 200, 'the UI, behind Umbrel\'s login, still works');
  } finally { fs.writeFileSync(tokensFile, good, { mode: 0o600 }); config.server.apiToken = legacy; }
});
