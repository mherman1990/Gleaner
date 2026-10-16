import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

/**
 * Point Gleaner at a throwaway data dir with the mock LLM. Call before importing anything from src/:
 * config is read once at import time. Delivery targets are blanked so a test can never reach Teams/ntfy.
 */
export function tempEnv(name, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `gleaner-${name}-`));
  for (const k of ['GLEANER_TEAMS_WEBHOOK', 'GLEANER_NTFY_URL', 'GLEANER_API_TOKEN', 'ANTHROPIC_API_KEY']) delete process.env[k];
  Object.assign(process.env, {
    GLEANER_DATA_DIR: dataDir, GLEANER_LLM: 'mock', GLEANER_SOURCE: 'fixture', GLEANER_FIXTURE_DIR: FIXTURES,
    TZ: 'America/Chicago', ...extra,
  });
  return dataDir;
}

/** Copy the fixture notebooks somewhere a test may edit them. */
export function copyFixtures() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gleaner-fx-'));
  fs.cpSync(FIXTURES, dir, { recursive: true });
  return dir;
}

/** The renderer needs rmc and cairosvg on PATH (see README → Development). */
export const rendererMissing = spawnSync('rmc', ['--version']).status !== 0 ||
  spawnSync('python3', ['-c', 'import cairosvg']).status !== 0
  ? 'rmc/cairosvg not installed' : false;
