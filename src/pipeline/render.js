import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, paths } from '../config.js';

const run = promisify(execFile);
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../py/render_page.py');

/** Render a page; returns { strokes, typed_text, pngPath|null }. Blank pages (no ink, no typed text) produce no PNG. */
export async function renderPage(page) {
  const pngPath = path.join(paths.renders, `${page.id}.png`);
  const { stdout } = await run('python3', [SCRIPT, page.rmPath, pngPath, String(config.llm.maxLongEdgePx)], { timeout: 180000 });
  const r = JSON.parse(stdout.trim().split('\n').at(-1));
  const typed = r.typed_text || '';
  return { strokes: r.strokes, typed_text: typed, pngPath: r.strokes || typed ? pngPath : null };
}
