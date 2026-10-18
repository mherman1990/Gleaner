// The project registry (/data/projects.yaml by default): canonical project tags and their aliases, the people Matt
// writes about, and context tags. It joins handwriting, the ledger, Cowork and Mayer, and it decides which projects
// are restricted. It lives on the Pi, never in this repo; config/projects.example.yaml shows the format and
// src/registry-schema.js the rules.
//
// - Reloaded when the file changes. Its stat (mtime, ctime, size, inode) is checked on each use, so no watcher is
//   needed and Docker bind mounts work. ctime catches a chmod or chown that makes an unreadable file readable.
// - A file that fails validation never replaces a good one. Every valid version is also saved next to the file
//   (.projects.yaml.last-good), and a broken file falls back to that saved copy, so every process (the service,
//   a `docker exec … cli.js`, either after a restart) uses the same last good version. The errors are reported
//   (doctor, the run log, /api/health).
// - A missing file means no registry: deleting it is deliberate.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as schema from './registry-schema.js';

export { parseRegistry, RegistryError, promptBlock, key as tagKey } from './registry-schema.js';

const lastGoodPath = (file) => path.join(path.dirname(file), `.${path.basename(file)}.last-good`);
const statKey = (p) => { try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.ctimeMs}:${s.size}:${s.ino}`; } catch { return 'absent'; } };
let cache = { path: null, stamp: null, registry: null, source: null, errors: null };

function fromLastGood(file) {
  try { return schema.parseRegistry(fs.readFileSync(lastGoodPath(file), 'utf8')); } catch { return null; }
}

/**
 * Save a valid version as the last good copy. It's written to a temporary file and renamed over the old copy, so a
 * full disk can't leave the copy empty or cut short. A failure is retried on every later use while the file is
 * unchanged, so other processes and a restart catch up.
 */
function save(file, text) {
  const saved = lastGoodPath(file);
  const tmp = `${saved}.${process.pid}.tmp`;
  try {
    if (!fs.existsSync(saved) || fs.readFileSync(saved, 'utf8') !== text) {
      fs.writeFileSync(tmp, text, { mode: 0o640 });
      fs.renameSync(tmp, saved);
    }
    if (cache.unsaved) console.log('[registry] saved the last good copy');
    cache.unsaved = null;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
    if (!cache.unsaved) {
      console.error(`[registry] couldn't save the last good copy, will retry: ${e.message}`);
      cache.savedStat = statKey(saved); // the copy as it was; a change means another process saved a newer one
    }
    cache.unsaved = text;
  }
}

/** The registry in use, reloaded if its file changed. null when there's no file and no valid version of it. */
export function currentRegistry() {
  const file = config.registry.path;
  if (cache.path !== file) cache = { path: file, stamp: null, registry: null, source: null, errors: null };
  let st;
  try { st = fs.statSync(file); }
  catch { cache = { path: file, stamp: null, registry: null, source: null, errors: null }; return null; }
  const stamp = `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
  if (cache.stamp === stamp) {
    if (cache.unsaved && cache.source === 'file') save(file, cache.unsaved); // still the live file's text: newest
    return cache.registry;
  }
  cache.stamp = stamp;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
    const r = schema.parseRegistry(text);
    if (r.version !== cache.registry?.version) console.log(`[registry] ${file}: version ${r.version}, ${r.projects.length} projects`);
    cache = { ...cache, registry: r, source: 'file', errors: null, unsaved: null };
    save(file, text);
  } catch (e) {
    // The saved copy, not the version this process last loaded: another process may have saved a newer good one
    // since. This process's own version wins only while it is unsaved and nothing else has replaced the saved copy.
    const own = cache.unsaved && statKey(lastGoodPath(file)) === cache.savedStat;
    const inUse = own ? cache.registry : fromLastGood(file) || cache.registry;
    cache = { ...cache, errors: e.errors || [e.message], fileWarnings: e.warnings || [], registry: inUse, source: inUse ? 'last-good' : null };
    console.error(`[registry] ${file} rejected, using ${cache.registry ? `the last good version ${cache.registry.version}` : 'no registry'}: ${cache.errors.join('; ')}`);
  }
  return cache.registry;
}

/**
 * For doctor, run logs and /api/health. `source` says whether the live file or the saved last good copy is in use.
 * errors and warnings describe the live file: when it's rejected, its warnings often explain the errors.
 */
export function registryStatus() {
  const r = currentRegistry();
  return {
    path: config.registry.path, loaded: !!r, source: r ? cache.source : null, version: r?.version ?? null,
    projects: r?.projects.length ?? 0, restricted: r ? r.projects.filter((p) => p.sensitivity === 'restricted').length : 0,
    warnings: cache.errors ? cache.fileWarnings ?? [] : r?.warnings ?? [], errors: cache.errors,
  };
}

// Lookups against the current registry (or one passed in; null means none). See registry-schema.js.
export const canonicalTag = (raw, r = currentRegistry()) => schema.canonicalTag(raw, r);
export const canonicalTags = (tags, r = currentRegistry()) => schema.canonicalTags(tags, r);
export const unregisteredTags = (tags, r = currentRegistry()) => schema.unregisteredTags(tags, r);
export const resolvePerson = (raw, r = currentRegistry()) => schema.resolvePerson(raw, r);
export const isFirstNameOf = (raw, fullName, r = currentRegistry()) => schema.isFirstNameOf(raw, fullName, r);
export const personAmbiguous = (item, r = currentRegistry()) => schema.personAmbiguous(item, r);
