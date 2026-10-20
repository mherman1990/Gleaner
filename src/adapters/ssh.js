// SSH adapter — reads the tablet's xochitl directory directly over USB (10.11.99.1) or Wi-Fi.
// No Connect subscription and no cloud dependency, but needs developer mode / SSH access.
// The tablet has no rsync, so we stream a tar of notebook metadata + .rm pages (no PDFs/ebooks).
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config.js';
import { bundleFromDir } from './bundle.js';

const run = promisify(execFile);
const XOCHITL = '/home/root/.local/share/remarkable/xochitl';
const mirror = path.join(paths.raw, '_ssh');

const sshArgs = () => [
  '-i', config.source.sshKey, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(paths.secrets, 'known_hosts')}`,
  `${config.source.sshUser}@${config.source.sshHost}`,
];

export const name = 'ssh';

async function sync() {
  fs.mkdirSync(mirror, { recursive: true });
  // Only what Gleaner needs. If the tablet's busybox tar lacks --exclude, drop the excludes.
  const remote = `cd ${XOCHITL} && tar cf - --exclude='*.pdf' --exclude='*.epub' --exclude='*.thumbnails' --exclude='*.cache' --exclude='*.highlights' --exclude='*.textconversion' .`;
  await new Promise((resolve, reject) => {
    const ssh = spawn('ssh', [...sshArgs(), remote]);
    const tar = spawn('tar', ['xf', '-', '-C', mirror]);
    ssh.stdout.pipe(tar.stdin);
    let err = '';
    ssh.stderr.on('data', (d) => (err += d));
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}: ${err}`))));
    ssh.on('error', reject);
  });
}

function readMeta() {
  const metas = new Map();
  for (const f of fs.readdirSync(mirror)) {
    if (!f.endsWith('.metadata')) continue;
    try { metas.set(f.replace(/\.metadata$/, ''), JSON.parse(fs.readFileSync(path.join(mirror, f), 'utf8'))); } catch { /* skip */ }
  }
  return metas;
}

function folderPath(metas, id) {
  const parts = [];
  for (let m = metas.get(metas.get(id)?.parent); m; m = metas.get(m.parent)) parts.unshift(m.visibleName);
  return '/' + parts.join('/');
}

export async function doctor() {
  const out = { adapter: name, host: config.source.sshHost, key: fs.existsSync(config.source.sshKey) };
  try { out.uname = (await run('ssh', [...sshArgs(), 'uname -a'], { timeout: 20000 })).stdout.trim(); }
  catch (e) { out.error = e.message; return out; }
  out.documents = (await listDocuments()).length;
  return out;
}

/** For the health check: can the tablet be reached over SSH? { ok, detail }. */
export async function authCheck() {
  try {
    await run('ssh', [...sshArgs(), 'uname'], { timeout: 20000 });
    return { ok: true, detail: `reached ${config.source.sshHost}` };
  } catch (e) {
    return { ok: false, detail: `ssh ${config.source.sshHost}: ${(e.stderr?.toString() || e.message || 'failed').trim().slice(0, 300)}` };
  }
}

export async function listDocuments() {
  await sync();
  const metas = readMeta();
  const root = config.source.folder.replace(/\/$/, '');
  return [...metas.entries()]
    .filter(([, m]) => m.type === 'DocumentType' && !m.deleted && m.parent !== 'trash')
    .map(([id, m]) => ({ id, name: m.visibleName, folder: folderPath(metas, id), version: String(m.version ?? m.lastModified ?? ''), modified: m.lastModified ? new Date(Number(m.lastModified)).toISOString() : null }))
    .filter((d) => d.folder === root || d.folder.startsWith(root + '/'));
}

export async function pull(doc) {
  // Already mirrored by listDocuments(); just read it.
  return bundleFromDir(mirror, doc.id, doc);
}

/** Best effort: the USB web interface accepts PDF uploads (Settings → Storage → USB web interface). */
export async function upload(localPdf) {
  if (config.source.sshHost !== '10.11.99.1') return false;
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(localPdf)], { type: 'application/pdf' }), path.basename(localPdf));
  const r = await fetch('http://10.11.99.1/upload', { method: 'POST', body: form });
  return r.ok;
}
