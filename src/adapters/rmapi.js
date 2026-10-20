// Cloud adapter — shells out to ddvk/rmapi (maintained fork; pinned in the Dockerfile).
// Requires reMarkable Connect. Auth is a one-time code registered interactively (see README).
// rmapi speaks an unofficial, reverse-engineered protocol: if reMarkable changes it, this adapter
// breaks and the rest of Gleaner keeps working on what it already has. `gleaner doctor` checks it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { config, paths } from '../config.js';
import { bundleFromDir, docIdInDir } from './bundle.js';

const run = promisify(execFile);
const env = () => ({ ...process.env, RMAPI_CONFIG: config.source.rmapiConfig });

async function rmapi(args, opts = {}) {
  const { stdout } = await run(config.source.rmapiBin, ['-ni', ...args], {
    env: env(), maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000, ...opts,
  });
  return stdout;
}

export const name = 'rmapi';

export async function doctor() {
  const out = { adapter: name, configFile: config.source.rmapiConfig, authenticated: fs.existsSync(config.source.rmapiConfig) };
  try { out.version = (await rmapi(['version'])).trim(); } catch (e) { out.versionError = e.message; }
  try {
    const raw = await rmapi(['-json', 'find', config.source.folder]);
    out.findSample = raw.slice(0, 600);
    out.documents = (await listDocuments()).length;
  } catch (e) { out.findError = e.stderr?.toString() || e.message; }
  return out;
}

/**
 * For the health check every 15 minutes: one `ls` of the folder, so a lapsed reMarkable sign-in shows up within the
 * quarter hour (about 64 cloud calls a day, no downloads). { ok, detail }.
 */
export async function authCheck() {
  try {
    await rmapi(['ls', config.source.folder], { timeout: 60 * 1000 });
    return { ok: true, detail: `listed ${config.source.folder}` };
  } catch (e) {
    const why = (e.stderr?.toString() || e.message || '').trim().split('\n').filter(Boolean).at(-1) || 'failed';
    return { ok: false, detail: `rmapi ls ${config.source.folder}: ${why.slice(0, 300)}` };
  }
}

/**
 * The JSON array from `rmapi -json find`. rmapi sends WARNING log lines to stdout too, so parse from the line
 * where the array starts rather than the whole buffer. Text-mode lines ("[f] /Daily/x") never match.
 */
export function parseFindJson(raw) {
  const start = raw.search(/^\[\s*(\{|\]|$)/m);
  if (start < 0) return null;
  const body = raw.slice(start);
  try { return JSON.parse(body); } catch { /* trailing log lines */ }
  try { return JSON.parse(body.slice(0, body.lastIndexOf(']') + 1)); } catch { return null; }
}

/** Documents (notebooks) under the configured folder. */
export async function listDocuments() {
  const root = config.source.folder;
  const raw = await rmapi(['-json', 'find', root]);
  const nodes = parseFindJson(raw);

  if (Array.isArray(nodes)) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const folderPath = (n) => {
      const parts = [];
      for (let p = byId.get(n.parent); p; p = byId.get(p.parent)) parts.unshift(p.name);
      return parts.join('/');
    };
    // `version` comes from the doc's .metadata, which current firmware no longer bumps (often 0), so it can't
    // detect edits on its own. modifiedClient (metadata lastModified) changes on every edit; key on both.
    return nodes
      .filter((n) => n.type === 'DocumentType')
      .map((n) => ({ id: n.id, name: n.name, folder: folderPath(n) || root, version: `${n.version ?? ''}:${n.modifiedClient ?? ''}`, modified: n.modifiedClient || null }));
  }

  // Text fallback: lines like "[f] /Daily/2026-10 Daily" — no ids, so we key on path.
  console.warn('[rmapi] find output was not JSON; falling back to text listing (every document is re-pulled each run)');
  return raw.split('\n').map((l) => l.match(/^\[f\]\s+(.+)$/)).filter(Boolean).map((m) => {
    const p = m[1].trim();
    return { id: null, path: p, name: path.posix.basename(p), folder: path.posix.dirname(p), version: '', modified: null };
  });
}

/** Download one document and return a DocBundle. */
export async function pull(doc) {
  const tmp = fs.mkdtempSync(path.join(paths.raw, '.dl-'));
  try {
    await rmapi(doc.id ? ['get', '--id', doc.id] : ['get', doc.path], { cwd: tmp });
    const file = fs.readdirSync(tmp).find((f) => /\.(rmdoc|zip)$/i.test(f));
    if (!file) throw new Error(`rmapi get produced no .rmdoc/.zip for ${doc.name}`);
    const zip = new AdmZip(path.join(tmp, file));
    const staging = path.join(tmp, 'x');
    zip.extractAllTo(staging, true);
    const docId = doc.id || docIdInDir(staging);
    const dest = path.join(paths.raw, docId);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
    return bundleFromDir(dest, docId, { name: doc.name, folder: doc.folder, version: doc.version, modified: doc.modified });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Upload (replace) a PDF on the tablet — used for the morning Today sheet. */
export async function upload(localPdf, folder) {
  await rmapi(['put', '--force', localPdf, folder]);
  return true;
}
