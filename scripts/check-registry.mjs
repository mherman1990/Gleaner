#!/usr/bin/env node
// Check a projects.yaml anywhere with Node 22 and this repo's dependencies (`npm ci`), before copying it to the Pi.
// Needs no data folder or database. Inside the app, `node src/cli.js registry check` does the same.
//
//   node scripts/check-registry.mjs path/to/projects.yaml
import fs from 'node:fs';
import { parseRegistry } from '../src/registry-schema.js';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/check-registry.mjs path/to/projects.yaml'); process.exit(2); }
try {
  const r = parseRegistry(fs.readFileSync(file, 'utf8'));
  console.log(JSON.stringify({ file, version: r.version, projects: r.projects.length,
    restricted: r.projects.filter((p) => p.sensitivity === 'restricted').map((p) => p.tag),
    people: r.people.length, contexts: r.contexts, warnings: r.warnings }, null, 2));
} catch (e) {
  console.error(`${file} is not valid:\n${(e.errors || [e.message]).map((x) => `  - ${x}`).join('\n')}` +
    `${e.warnings?.length ? `\nwarnings (a typo here may explain an error):\n${e.warnings.map((x) => `  - ${x}`).join('\n')}` : ''}`);
  process.exit(1);
}
