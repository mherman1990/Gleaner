// The Umbrel store package. Spotter's release runs check-store.mjs over every app folder in the
// shared Herman Apps store, so herman-gleaner must pass it or it breaks Spotter's releases too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'umbrel-store', 'herman-gleaner');
const node = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8' });

/** A store shaped like mherman1990/spotter-umbrel-store, holding a copy of herman-gleaner/. */
function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gleaner-store-'));
  fs.writeFileSync(path.join(dir, 'umbrel-app-store.yml'), 'id: herman\nname: Herman Apps\n');
  fs.cpSync(APP, path.join(dir, 'herman-gleaner'), { recursive: true });
  return dir;
}

test('herman-gleaner passes the store checks Spotter runs', () => {
  const r = node(path.join(ROOT, 'scripts/check-store.mjs'), tempStore());
  assert.equal(r.status, 0, r.stderr);
});

test('every file of the listing is committed, not just on disk', () => {
  const git = spawnSync('git', ['-C', ROOT, 'ls-files', 'umbrel-store/herman-gleaner'], { encoding: 'utf8' });
  if (git.status !== 0) return; // not a git checkout (e.g. a source tarball)
  const tracked = new Set(git.stdout.trim().split('\n'));
  for (const f of ['umbrel-app.yml', 'docker-compose.yml', 'icon.svg', 'data/.gitkeep']) {
    assert.ok(tracked.has(`umbrel-store/herman-gleaner/${f}`), `${f} is not tracked by git (ignored?)`);
  }
});

test('the manifest matches the app: port, proxy target, icon, image', () => {
  const manifest = fs.readFileSync(path.join(APP, 'umbrel-app.yml'), 'utf8');
  const compose = fs.readFileSync(path.join(APP, 'docker-compose.yml'), 'utf8');
  assert.match(manifest, /^port: 3717$/m);
  assert.match(compose, /APP_HOST: herman-gleaner_web_1$/m);
  assert.match(compose, /APP_PORT: 3717$/m, 'the server listens on 3717 inside the container');
  assert.match(compose, /PROXY_AUTH_WHITELIST: "\/api\/\*"$/m, 'only the token-protected API skips Umbrel login');
  assert.match(manifest, /^icon: https:\/\/raw\.githubusercontent\.com\/mherman1990\/spotter-umbrel-store\/main\/herman-gleaner\/icon\.svg$/m);
  assert.ok(fs.existsSync(path.join(APP, 'icon.svg')));
  assert.match(compose, /^\s+image: ghcr\.io\/mherman1990\/gleaner:\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/m);
});

test('bump-store pins a new version and digest', () => {
  const store = tempStore();
  const digest = `sha256:${'ab'.repeat(32)}`;
  const r = node(path.join(ROOT, 'scripts/bump-store.mjs'), '--store', store, '--version', 'v0.2.0', '--digest', digest);
  assert.equal(r.status, 0, r.stderr);
  const manifest = fs.readFileSync(path.join(store, 'herman-gleaner/umbrel-app.yml'), 'utf8');
  const compose = fs.readFileSync(path.join(store, 'herman-gleaner/docker-compose.yml'), 'utf8');
  assert.match(manifest, /^version: "0\.2\.0"$/m);
  assert.match(compose, new RegExp(`^\\s+image: ghcr\\.io/mherman1990/gleaner:0\\.2\\.0@${digest}$`, 'm'));
  assert.equal(node(path.join(ROOT, 'scripts/check-store.mjs'), store).status, 0);
});

test('bump-store refuses a malformed digest', () => {
  const r = node(path.join(ROOT, 'scripts/bump-store.mjs'), '--store', tempStore(), '--version', '0.2.0', '--digest', 'sha256:nope');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /invalid --digest/);
});
