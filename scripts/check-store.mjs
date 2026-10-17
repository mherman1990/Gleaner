#!/usr/bin/env node
// Structural checks for the Umbrel community store package. Dependency-free so
// it runs in the release workflow without `npm ci`.
// Copied verbatim from the spotter repo: Spotter's release runs it over every app in the store,
// herman-gleaner included, so Gleaner has to pass these exact rules.
//
//   node scripts/check-store.mjs [storeDir=umbrel-store]
import fs from 'node:fs';
import path from 'node:path';

const store = process.argv[2] ?? 'umbrel-store';
const errors = [];
const check = (ok, msg) => ok || errors.push(msg);
const read = (p) =>
  fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : (errors.push(`missing ${p}`), '');
const topLevel = (yml, key) =>
  yml.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.replace(/^["']|["']$/g, '');

const storeYml = read(path.join(store, 'umbrel-app-store.yml'));
const storeId = topLevel(storeYml, 'id');
check(
  storeId && /^[a-z-]+$/.test(storeId),
  'umbrel-app-store.yml: id must be lowercase letters/dashes',
);

const apps = fs
  .readdirSync(store, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.'));
check(apps.length > 0, 'no app folders found');

for (const { name } of apps) {
  const dir = path.join(store, name);
  const manifest = read(path.join(dir, 'umbrel-app.yml'));
  const compose = read(path.join(dir, 'docker-compose.yml'));
  const id = topLevel(manifest, 'id');

  check(id === name, `${name}: manifest id "${id}" must match folder name`);
  check(
    name.startsWith(`${storeId}-`),
    `${name}: folder must be prefixed with store id "${storeId}-"`,
  );
  check(topLevel(manifest, 'manifestVersion') === '1', `${name}: manifestVersion must be 1`);
  for (const key of [
    'name',
    'tagline',
    'icon',
    'category',
    'version',
    'port',
    'description',
    'developer',
    'website',
    'support',
    'gallery',
  ]) {
    check(topLevel(manifest, key) !== undefined, `${name}: umbrel-app.yml missing "${key}"`);
  }
  check(
    /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(topLevel(manifest, 'version') ?? ''),
    `${name}: version must be semver`,
  );
  const port = Number(topLevel(manifest, 'port'));
  check(
    Number.isInteger(port) && port > 1024 && port < 65536,
    `${name}: port must be an integer > 1024`,
  );
  check(/^path: ""$/m.test(manifest), `${name}: path must be ""`);

  check(/^\s+app_proxy:/m.test(compose), `${name}: docker-compose.yml needs an app_proxy service`);
  const appHost = compose.match(/APP_HOST:\s*"?([\w-]+)"?/)?.[1];
  check(
    appHost?.startsWith(`${id}_`) && appHost.endsWith('_1'),
    `${name}: APP_HOST must be ${id}_<service>_1`,
  );
  check(/APP_PORT:\s*"?\d+"?/.test(compose), `${name}: APP_PORT missing`);
  check(!/PROXY_AUTH_ADD:\s*"?false"?/.test(compose), `${name}: Umbrel proxy auth must stay on`);
  for (const [, image] of compose.matchAll(/^\s+image:\s*(\S+)$/gm)) {
    check(
      /^[\w./-]+:[\w.-]+@sha256:[a-f0-9]{64}$/.test(image),
      `${name}: image "${image}" must be pinned as name:tag@sha256:digest`,
    );
  }
  check(
    /\$\{APP_DATA_DIR\}\/data:\/data/.test(compose),
    `${name}: must persist \${APP_DATA_DIR}/data to /data`,
  );
  check(
    fs.existsSync(path.join(dir, 'data', '.gitkeep')),
    `${name}: add data/.gitkeep so Umbrel creates /data owned by uid 1000`,
  );
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log(`✓ ${apps.length} app(s) in ${store} look valid`);
