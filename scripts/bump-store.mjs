#!/usr/bin/env node
// Points the Umbrel store package at a published image.
// Shared with the spotter repo (scripts/bump-store.mjs); keep the two in step.
//
//   node scripts/bump-store.mjs --store <dir> --version 0.2.0 \
//     --digest sha256:abc… [--image ghcr.io/mherman1990/gleaner] [--notes "…"]
//
// Edits <dir>/herman-gleaner/umbrel-app.yml (version, releaseNotes) and
// <dir>/herman-gleaner/docker-compose.yml (image pinned by tag + digest).
// Plain text edits rather than a YAML round-trip, so comments and layout survive.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    store: { type: 'string', default: 'umbrel-store' },
    app: { type: 'string', default: 'herman-gleaner' },
    version: { type: 'string' },
    digest: { type: 'string' },
    image: { type: 'string', default: 'ghcr.io/mherman1990/gleaner' },
    notes: { type: 'string' },
  },
});

const fail = (msg) => {
  console.error(`bump-store: ${msg}`);
  process.exit(1);
};

const version = values.version?.replace(/^v/, '');
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version))
  fail(`invalid --version "${values.version}"`);
if (!values.digest || !/^sha256:[a-f0-9]{64}$/.test(values.digest))
  fail(`invalid --digest "${values.digest}"`);

const appDir = path.join(values.store, values.app);
const manifestPath = path.join(appDir, 'umbrel-app.yml');
const composePath = path.join(appDir, 'docker-compose.yml');

function replaceOnce(text, pattern, replacement, label) {
  if (!pattern.test(text)) fail(`could not find ${label}`);
  return text.replace(pattern, replacement);
}

let manifest = fs.readFileSync(manifestPath, 'utf8');
manifest = replaceOnce(
  manifest,
  /^version: .*$/m,
  `version: "${version}"`,
  'version in umbrel-app.yml',
);
if (values.notes) {
  const block = values.notes
    .trim()
    .split('\n')
    .map((l) => (l ? `  ${l}` : ''))
    .join('\n');
  manifest = replaceOnce(
    manifest,
    /^releaseNotes: >-\n(?:(?: {2}.*)?\n)*?(?=^\S)/m,
    `releaseNotes: >-\n${block}\n`,
    'releaseNotes in umbrel-app.yml',
  );
}
fs.writeFileSync(manifestPath, manifest);

const escaped = values.image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let compose = fs.readFileSync(composePath, 'utf8');
compose = replaceOnce(
  compose,
  new RegExp(`^(\\s*image: )${escaped}:[^\\s]+$`, 'm'),
  `$1${values.image}:${version}@${values.digest}`,
  `image ${values.image} in docker-compose.yml`,
);
fs.writeFileSync(composePath, compose);

console.log(`bump-store: ${values.app} → ${version} (${values.digest.slice(0, 19)}…)`);
