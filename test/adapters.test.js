// The rmapi adapter, driven through a fake `rmapi` that reproduces ddvk/rmapi v0.0.35's real behavior:
// `-json find` prints a MarshalIndent'ed array (and WARNING log lines go to stdout too), and
// `get --id` writes "<name>.rmdoc", a zip of <docId>.content/.metadata and <docId>/<pageId>.rm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { tempEnv, FIXTURES } from './helpers.js';

const dataDir = tempEnv('adapters');
const fake = path.join(dataDir, 'fake-rmapi');
fs.mkdirSync(fake);
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ source: { rmapiBin: path.join(fake, 'rmapi') } }));

const DOC = 'a1b2c3d4-0000-4000-8000-000000000001';
const nodes = [
  { id: 'f-daily', name: 'Daily', type: 'CollectionType', version: 0, modifiedClient: '2026-10-01T12:00:00Z', parent: '' },
  { id: DOC, name: 'Oct 2026', type: 'DocumentType', version: 0, modifiedClient: '2026-10-16T13:05:00Z', parent: 'f-daily' },
  { id: 'f-sub', name: 'Board', type: 'CollectionType', version: 0, modifiedClient: '', parent: 'f-daily' },
  { id: 'doc-2', name: 'ISA board', type: 'DocumentType', version: 3, modifiedClient: '2026-10-10T09:00:00Z', parent: 'f-sub' },
];
fs.writeFileSync(path.join(fake, 'find.txt'),
  `WARNING: 2026/10/16 19:00:00 tree.go:88: cache is stale, refreshing\n${JSON.stringify(nodes, null, 2)}\n`);

const zip = new AdmZip();
zip.addFile(`${DOC}.metadata`, Buffer.from(JSON.stringify({ visibleName: 'Oct 2026', type: 'DocumentType', lastModified: '1792155900000' })));
zip.addFile(`${DOC}.content`, Buffer.from(JSON.stringify({
  fileType: 'notebook',
  cPages: { pages: [
    { id: 'pg-b', idx: { value: 'bb' } },
    { id: 'pg-gone', idx: { value: 'bc' }, deleted: { value: 1 } },
    { id: 'pg-a', idx: { value: 'ba' } },
    { id: 'pg-unwritten', idx: { value: 'bd' } },
  ] },
})));
zip.addFile(`${DOC}/pg-a.rm`, fs.readFileSync(path.join(FIXTURES, 'Daily/01.rm')));
zip.addFile(`${DOC}/pg-b.rm`, fs.readFileSync(path.join(FIXTURES, 'Daily/02.rm')));
zip.addFile(`${DOC}/pg-gone.rm`, fs.readFileSync(path.join(FIXTURES, 'Daily/03.rm')));
zip.writeZip(path.join(fake, 'doc.rmdoc'));

fs.writeFileSync(path.join(fake, 'rmapi'), `#!/bin/sh
echo "$*" >> "${fake}/calls.log"
case "$*" in
  *" find "*) cat "${fake}/find.txt" ;;
  *"get --id ${DOC}"*) cp "${fake}/doc.rmdoc" "./Oct 2026.rmdoc"; echo "downloading: [Oct 2026]..."; echo OK ;;
  *version*) echo v0.0.35 ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });

const rmapi = await import('../src/adapters/rmapi.js');
const { pageOrder } = await import('../src/adapters/bundle.js');

test('parseFindJson tolerates log lines around the JSON and rejects text output', () => {
  assert.deepEqual(rmapi.parseFindJson('[]\n'), []);
  assert.equal(rmapi.parseFindJson('WARNING: x\n[\n  {"id": "a"}\n]\n')[0].id, 'a');
  assert.equal(rmapi.parseFindJson('[\n  {"id": "a"}\n]\nWARNING: trailing\n')[0].id, 'a');
  assert.equal(rmapi.parseFindJson('[d] /Daily/Board\n[f] /Daily/Oct 2026\n'), null);
});

test('listDocuments: notebooks only, folder paths, and a version that changes on edit', async () => {
  const docs = await rmapi.listDocuments();
  assert.deepEqual(docs.map((d) => d.name), ['Oct 2026', 'ISA board']);
  assert.equal(docs[0].id, DOC);
  assert.equal(docs[1].folder, 'Daily/Board');
  // .metadata "version" stays 0 on current firmware; modifiedClient is what moves.
  assert.equal(docs[0].version, '0:2026-10-16T13:05:00Z');
  assert.match(fs.readFileSync(path.join(fake, 'calls.log'), 'utf8'), /^-ni -json find \/Daily$/m);
});

test('pull: extracts the .rmdoc into a bundle with live pages in tablet order', async () => {
  const [doc] = await rmapi.listDocuments();
  const b = await rmapi.pull(doc);
  assert.equal(b.id, DOC);
  assert.equal(b.fileType, 'notebook');
  assert.deepEqual(b.pages.map((p) => p.id), ['pg-a', 'pg-b'], 'deleted and never-written pages are skipped');
  assert.deepEqual(b.pages.map((p) => p.index), [0, 1]);
  assert.ok(fs.existsSync(b.pages[0].rmPath));
  assert.equal(path.dirname(b.pages[0].rmPath), path.join(dataDir, 'raw', DOC, DOC));
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'raw')).filter((f) => f.startsWith('.dl-')), [], 'temp dir cleaned up');
});

test('pageOrder handles the pre-v6 flat page list', () => {
  assert.deepEqual(pageOrder({ pages: ['x', 'y'] }), ['x', 'y']);
  assert.deepEqual(pageOrder(null), []);
});
