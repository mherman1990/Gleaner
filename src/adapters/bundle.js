// A DocBundle is the one shape every source adapter produces:
//   { id, name, folder, modified, version, pages: [{ id, index, rmPath }] }
// The on-disk layout is the same whether it came from an .rmdoc zip (cloud) or the tablet's
// xochitl directory (SSH): <id>.metadata, <id>.content, <id>/<pageId>.rm
import fs from 'node:fs';
import path from 'node:path';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/** Ordered, non-deleted page ids from a .content file (handles v6 cPages and the older flat list). */
export function pageOrder(content) {
  if (!content) return [];
  const cp = content.cPages?.pages;
  if (Array.isArray(cp)) {
    return cp
      .filter((p) => !p.deleted || !p.deleted.value)
      .map((p, i) => ({ id: p.id, key: p.idx?.value ?? String(i).padStart(6, '0') }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((p) => p.id);
  }
  if (Array.isArray(content.pages)) return content.pages;
  return [];
}

/** Build a bundle from a directory holding <docId>.content / .metadata / <docId>/ */
export function bundleFromDir(dir, docId, extra = {}) {
  const meta = readJson(path.join(dir, `${docId}.metadata`)) || {};
  const content = readJson(path.join(dir, `${docId}.content`)) || {};
  const pageDir = path.join(dir, docId);
  const ids = pageOrder(content);
  const pages = ids
    .map((pid, index) => ({ id: pid, index, rmPath: path.join(pageDir, `${pid}.rm`) }))
    .filter((p) => fs.existsSync(p.rmPath)); // pages never written on have no .rm file
  return {
    id: docId,
    name: extra.name ?? meta.visibleName ?? docId,
    folder: extra.folder ?? '',
    modified: extra.modified ?? (meta.lastModified ? new Date(Number(meta.lastModified)).toISOString() : null),
    version: String(extra.version ?? meta.version ?? meta.lastModified ?? ''),
    fileType: content.fileType || 'notebook',
    pages,
  };
}

/** Find the doc id inside an extracted .rmdoc (the one *.content file). */
export function docIdInDir(dir) {
  const f = fs.readdirSync(dir).find((n) => n.endsWith('.content'));
  return f ? f.replace(/\.content$/, '') : null;
}
