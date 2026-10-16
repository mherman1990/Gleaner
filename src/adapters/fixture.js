// Fixture adapter — for development and CI without a tablet.
// Layout: <fixtureDir>/<Notebook Name>/<NN>.rm  (pages in filename order)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, paths } from '../config.js';

export const name = 'fixture';
const sid = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const dir = () => path.resolve(config.source.fixtureDir);

export async function doctor() { return { adapter: name, dir: dir(), documents: (await listDocuments()).length }; }

export async function listDocuments() {
  if (!fs.existsSync(dir())) return [];
  return fs.readdirSync(dir(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
    const files = fs.readdirSync(path.join(dir(), d.name)).filter((f) => f.endsWith('.rm')).sort();
    const version = sid(files.map((f) => f + fs.statSync(path.join(dir(), d.name, f)).mtimeMs).join());
    return { id: `fx-${sid(d.name)}`, name: d.name, folder: config.source.folder, version, modified: new Date().toISOString() };
  });
}

export async function pull(doc) {
  const src = path.join(dir(), doc.name);
  const pages = fs.readdirSync(src).filter((f) => f.endsWith('.rm')).sort()
    .map((f, index) => ({ id: `${doc.id}-p${sid(f)}`, index, rmPath: path.join(src, f) }));
  return { ...doc, fileType: 'notebook', pages };
}

export async function upload(localPdf) {
  const dest = path.join(paths.out, 'fixture-tablet-upload.pdf');
  fs.copyFileSync(localPdf, dest);
  return true;
}
