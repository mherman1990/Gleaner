// Per-client API tokens (spec §1.2). /data/tokens.json holds only sha256 hashes:
//   [{ "client": "mayer", "hash": "<sha256 hex>", "scopes": ["read", …], "sensitivity": "all" | "normal", "created": "<ISO>" }]
// `node src/cli.js token add <client> --scopes … --sensitivity …` prints a new token once; `token revoke`, `token list`.
// The file is re-read when it changes (no restart), written by rename with mode 0600, and never logged.
//
// GLEANER_API_TOKEN still works through v0.2.x as client "legacy", with every scope and sensitivity "all".
// The browser UI (/ui-api, behind Umbrel's login) is client "ui", with the same rights.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const SCOPES = ['read', 'write', 'create', 'ingest', 'digest'];
export const SENSITIVITIES = ['all', 'normal'];
// Names an API client can't take: the attributions Gleaner writes itself.
const RESERVED = ['handwriting', 'erased', 'ui', 'cli', 'legacy', 'api'];
const CLIENT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const UI_CLIENT = Object.freeze({ client: 'ui', scopes: SCOPES, sensitivity: 'all' });
const LEGACY = Object.freeze({ client: 'legacy', scopes: SCOPES, sensitivity: 'all' });

const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const stamp = (p) => { try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.ino}`; } catch { return 'absent'; } };
let cache = { path: null, stamp: null, tokens: [], error: null };

function validEntry(t) {
  return t && typeof t === 'object' && CLIENT_NAME.test(t.client ?? '') && !RESERVED.includes(t.client) &&
    /^[0-9a-f]{64}$/.test(t.hash ?? '') && Array.isArray(t.scopes) && t.scopes.every((s) => SCOPES.includes(s)) &&
    SENSITIVITIES.includes(t.sensitivity);
}

/** The tokens in use, re-read when the file changes. A file that can't be read or parsed gives no tokens (closed). */
export function tokens() {
  const file = config.auth.tokensPath;
  const s = stamp(file);
  if (cache.path === file && cache.stamp === s) return cache.tokens;
  cache = { path: file, stamp: s, tokens: [], error: null };
  if (s === 'absent') return cache.tokens;
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) throw new Error('expected a JSON list');
    const bad = list.filter((t) => !validEntry(t));
    if (bad.length) throw new Error(`${bad.length} entr${bad.length === 1 ? 'y is' : 'ies are'} malformed`);
    cache.tokens = list;
  } catch (e) {
    cache.error = e.message;
    console.error(`[auth] ${file} ignored, no API tokens in use: ${e.message}`);
  }
  return cache.tokens;
}

/** Whether /api can accept anything: a token in tokens.json or the legacy env token. */
export const apiEnabled = () => tokens().length > 0 || !!config.server.apiToken;

/**
 * The client a request's Authorization header names, or null. Compares hashes in constant time. The scheme is
 * case-insensitive, and everything after it is the token, so a legacy token with a space in it still works.
 */
export function authenticate(header) {
  const h = String(header || '');
  const scheme = /^Bearer[ \t]+/i.exec(h); // anchored, no backtracking capture: linear on any header
  const token = scheme ? h.slice(scheme[0].length).trimEnd() : '';
  if (!token) return null;
  const given = Buffer.from(hashOf(token), 'hex');
  let found = null;
  for (const t of tokens()) {
    if (crypto.timingSafeEqual(given, Buffer.from(t.hash, 'hex')) && !found) found = t;
  }
  if (found) return { client: found.client, scopes: found.scopes, sensitivity: found.sensitivity };
  const legacy = config.server.apiToken;
  if (legacy && crypto.timingSafeEqual(given, Buffer.from(hashOf(legacy), 'hex'))) return LEGACY;
  return null;
}

function save(list) {
  const file = config.auth.tokensPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

/**
 * Run fn holding tokens.json.lock, so two `token` commands at once can't lose each other's change. A token command
 * takes milliseconds, so after 5 s of waiting it gives up and says so. A lock left by an interrupted command is not
 * cleared automatically (two waiters could both clear it and both write); the error says to delete it.
 */
export const LOCK_WAIT = { ms: 5000 }; // tests shorten it
function withLock(fn) {
  const lock = `${config.auth.tokensPath}.lock`;
  const mine = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (const end = Date.now() + LOCK_WAIT.ms; ;) {
    try { fs.writeFileSync(lock, mine, { flag: 'wx', mode: 0o600 }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > end) {
        throw new Error(`${lock} exists: another token command is running, or one was interrupted. If none is running, delete that file and try again.`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    cache.stamp = null; // read the file as it is now, not as this process last saw it
    return fn();
  } finally {
    try { if (fs.readFileSync(lock, 'utf8') === mine) fs.rmSync(lock); } catch { /* already gone */ }
  }
}

function current() {
  const list = tokens();
  if (cache.error) throw new Error(`${config.auth.tokensPath} can't be read (${cache.error}); fix or move it first`);
  return list;
}

/** Parse "read,write" or "all" into scopes. */
export function parseScopes(s) {
  const list = String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const scopes = list.includes('all') ? [...SCOPES] : [...new Set(list)];
  const bad = scopes.filter((x) => !SCOPES.includes(x));
  if (!scopes.length || bad.length) throw new Error(`scopes must be "all" or a comma list of ${SCOPES.join(', ')}`);
  return SCOPES.filter((x) => scopes.includes(x));
}

/** Create a client's token. Returns the token itself: it's shown once and only its hash is kept. */
export function addToken(client, { scopes, sensitivity = 'normal' }) {
  if (!CLIENT_NAME.test(client ?? '')) throw new Error('client must be lowercase letters, digits and dashes (up to 32)');
  if (RESERVED.includes(client)) throw new Error(`"${client}" is reserved for Gleaner's own attributions`);
  if (!SENSITIVITIES.includes(sensitivity)) throw new Error('sensitivity must be all or normal');
  const scopeList = parseScopes(scopes);
  return withLock(() => {
    const list = current();
    if (list.some((t) => t.client === client)) throw new Error(`${client} already has a token; revoke it first`);
    const token = `gl_${crypto.randomBytes(32).toString('base64url')}`;
    save([...list, { client, hash: hashOf(token), scopes: scopeList, sensitivity, created: new Date().toISOString() }]);
    return token;
  });
}

/** Remove a client's token. Returns whether there was one. */
export function revokeToken(client) {
  return withLock(() => {
    const list = current();
    const rest = list.filter((t) => t.client !== client);
    if (rest.length === list.length) return false;
    save(rest);
    return true;
  });
}

/** The clients, without their hashes, for `token list` and doctor. */
export function tokenStatus() {
  const list = tokens();
  return {
    path: config.auth.tokensPath, error: cache.error, legacy: !!config.server.apiToken,
    clients: list.map(({ client, scopes, sensitivity, created }) => ({ client, scopes, sensitivity, created })),
  };
}
