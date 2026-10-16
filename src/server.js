// Two mounts of the same router:
//   /api/*     — for machines (Claude via Desktop Commander, scripts). Requires Bearer token when configured.
//                Whitelisted past Umbrel's proxy auth in umbrel/docker-compose.yml.
//   /ui/api/*  — for the browser UI; sits behind Umbrel's own login via app_proxy.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, paths, localDate } from './config.js';
import { db, P, openItems, setItemStatus } from './db.js';
import { renderOpenLoops, dayFilePath, writeOpenLoops } from './output/markdown.js';
import { ingest } from './pipeline/ingest.js';
import { morningDigest, addDays } from './digest/digest.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
let busy = null; // single-flight guard for long jobs

function router() {
  const r = express.Router();
  r.use(express.json());

  r.get('/items', (req, res) => {
    const status = req.query.status || 'open';
    let rows = status === 'open' ? openItems() : db.prepare('SELECT * FROM items ORDER BY code DESC LIMIT 500').all();
    if (req.query.tag) rows = rows.filter((i) => P(i.tags).includes(req.query.tag));
    res.json(rows.map((i) => ({ ...i, tags: P(i.tags) })));
  });

  // Close / reopen / snooze by the printed number: {"status":"done"} | {"status":"snoozed","until":"2026-10-23"}
  r.post('/items/:code', (req, res) => {
    const item = db.prepare('SELECT id FROM items WHERE code=?').get(Number(req.params.code));
    if (!item) return res.status(404).json({ error: 'no such item' });
    const { status, until, note } = req.body || {};
    if (!['done', 'dropped', 'open', 'snoozed'].includes(status)) return res.status(400).json({ error: 'status must be done|dropped|open|snoozed' });
    if (status === 'snoozed' && !/^\d{4}-\d{2}-\d{2}$/.test(until || '')) return res.status(400).json({ error: 'snoozed needs until=YYYY-MM-DD' });
    setItemStatus(item.id, status, 'api', note || null, status === 'snoozed' ? until : null);
    writeOpenLoops();
    const row = db.prepare('SELECT * FROM items WHERE id=?').get(item.id);
    res.json({ ...row, tags: P(row.tags) });
  });

  r.get('/open-loops.md', (_req, res) => res.type('text/markdown').send(renderOpenLoops()));

  r.get('/digest/today', (_req, res) => {
    const f = path.join(paths.out, `digest-${localDate()}.md`);
    const latest = path.join(paths.out, 'digest-latest.md');
    if (fs.existsSync(f)) return res.type('text/markdown').send(fs.readFileSync(f, 'utf8'));
    if (fs.existsSync(latest)) return res.type('text/markdown').send(`<!-- stale: no digest yet today -->\n${fs.readFileSync(latest, 'utf8')}`);
    res.status(404).send('no digest yet');
  });

  // /notes?from=2026-10-12&to=2026-10-16  (defaults: last 3 days) → concatenated markdown
  r.get('/notes', (req, res) => {
    const to = req.query.to || localDate();
    const from = req.query.from || addDays(to, -2);
    const parts = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const f = dayFilePath(d);
      if (fs.existsSync(f)) parts.push(fs.readFileSync(f, 'utf8'));
    }
    res.type('text/markdown').send(parts.join('\n\n---\n\n') || `no notes ${from}..${to}`);
  });

  r.get('/notes/:date', (req, res) => {
    const f = dayFilePath(req.params.date);
    fs.existsSync(f) ? res.type('text/markdown').send(fs.readFileSync(f, 'utf8')) : res.status(404).send('none');
  });

  r.get('/search', (req, res) => {
    const q = `%${req.query.q || ''}%`;
    res.json(db.prepare(`SELECT p.page_date, d.name, p.page_index, p.summary FROM pages p JOIN documents d ON d.id=p.doc_id
      WHERE p.transcription_md LIKE ? ORDER BY p.page_date DESC LIMIT 50`).all(q));
  });

  r.post('/ingest', (req, res) => {
    if (busy) return res.status(409).json({ error: `busy: ${busy}` });
    const mode = req.body?.mode === 'batch' ? 'batch' : 'sync';
    busy = `ingest:${mode}`;
    ingest({ mode }).catch((e) => console.error(e)).finally(() => (busy = null));
    res.status(202).json({ started: busy });
  });

  r.post('/digest', async (req, res) => {
    try { const d = await morningDigest({ push: !!req.body?.push }); res.type('text/markdown').send(d.md); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/status', (_req, res) => res.json({
    busy,
    runs: db.prepare('SELECT kind, started_at, ended_at, ok, substr(detail,1,300) AS detail FROM runs ORDER BY id DESC LIMIT 10').all(),
    pages: db.prepare('SELECT status, COUNT(*) AS n FROM pages GROUP BY status').all(),
    usage30d: db.prepare(`SELECT model, purpose, batch, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
      SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write FROM usage WHERE at >= datetime('now','-30 days') GROUP BY 1,2,3`).all(),
  }));

  return r;
}

function requireToken(req, res, next) {
  const t = config.server.apiToken;
  if (!t) return next();
  if ((req.headers.authorization || '') === `Bearer ${t}`) return next();
  res.status(401).json({ error: 'unauthorized' });
}

export function startServer() {
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', requireToken, router());
  app.use('/ui/api', router());
  app.use(express.static(PUBLIC));
  app.listen(config.server.port, () => console.log(`[server] listening on :${config.server.port}`));
  if (!config.server.apiToken) console.warn('[server] GLEANER_API_TOKEN not set — /api is open to anything that can reach this port');
  return app;
}
