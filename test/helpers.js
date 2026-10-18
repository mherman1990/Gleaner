import fs from 'node:fs';
import http from 'node:http';
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

/** A local stand-in for an ntfy server: records each push, answers with `status`. */
export async function pushSink(status = 200) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { hits.push({ title: req.headers.title, body }); res.writeHead(status).end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/gleaner`, hits, close: () => server.close() };
}

/** The renderer needs rmc and cairosvg on PATH (see README → Development). */
export const rendererMissing = spawnSync('rmc', ['--version']).status !== 0 ||
  spawnSync('python3', ['-c', 'import cairosvg']).status !== 0
  ? 'rmc/cairosvg not installed' : false;
