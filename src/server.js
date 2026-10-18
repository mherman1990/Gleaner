// Two mounts of the same router:
//   /api/*     — for machines: Mayer (OpenClaw), the local MCP, Cowork, scripts. Each request needs a Bearer token
//                from /data/tokens.json (or the legacy GLEANER_API_TOKEN; src/auth.js), each route a scope, and a
//                client with sensitivity "normal" gets every response with restricted work left out
//                (src/sensitivity.js). Disabled while there's no token. Whitelisted past Umbrel's proxy auth in
//                umbrel-store/herman-gleaner/docker-compose.yml.
//   /ui-api/*  — for the browser UI, behind Umbrel's own login via app_proxy: client "ui", every scope, all work.
//                Not /ui/api: Umbrel checks its "/api/*" whitelist on the URL-parsed path, where //ui/api/items reads
//                as host "ui", path /api/items, and then forwards the raw path, so that mount was reachable with no
//                login. No route in router() starts with /api, so //ui-api/api/… finds nothing either.
// Changes are attributed to the client (closed_by, and the events table).
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, paths, localDate } from './config.js';
import { db, P, listItems, setItemStatus, editItem, EDITABLE, isDate } from './db.js';
import { renderOpenLoops, renderDay, dayFilePath, refreshItemOutputs } from './output/markdown.js';
import { ingest } from './pipeline/ingest.js';
import { morningDigest, addDays } from './digest/digest.js';
import { busy, exclusive } from './jobs.js';
import { canonicalTag, canonicalTags, unregisteredTags, personAmbiguous, tagKey } from './registry.js';
import { authenticate, apiEnabled, UI_CLIENT } from './auth.js';
import { visibility, NoRegistryError } from './sensitivity.js';
import { listEvents, parseSince } from './events.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
// unregistered_tags and person_ambiguous are worked out against the current registry, so they follow its edits.
// A close by number can be written on any page, restricted ones included, and close_evidence holds that page's words,
// so at sensitivity normal a handwriting close keeps its status but not its evidence.
const itemJson = (i, vis) => ({ ...i, tags: P(i.tags), edited: P(i.edited), person_ambiguous: personAmbiguous(i),
  unregistered_tags: unregisteredTags(P(i.tags)), ...(!vis.all && i.closed_by === 'handwriting' ? { close_evidence: null } : {}) });

/** The routes, for both mounts. Each request arrives with req.client = { client, scopes, sensitivity }. */
export function router() {
  const r = express.Router();
  r.use(express.json());
  const can = (scope) => (req, res, next) => (req.client.scopes.includes(scope) ? next()
    : res.status(403).json({ error: `client ${req.client.client} lacks the ${scope} scope` }));
  // What this client may see. null once a 503 has been sent: with no registry, restricted work can't be filtered.
  const view = (req, res) => {
    try { return visibility(req.client.sensitivity); } catch (e) {
      if (!(e instanceof NoRegistryError)) throw e;
      res.status(503).json({ error: e.message });
      return null;
    }
  };
  const itemByCode = (code, vis) => {
    const item = db.prepare('SELECT * FROM items WHERE code=?').get(Number(code));
    return item && vis.item(item) ? item : null;
  };

  // ?status=open (default) | snoozed | closed | all
  r.get('/items', can('read'), (req, res) => {
    const vis = view(req, res);
    if (!vis) return;
    let rows;
    try { rows = listItems(req.query.status || 'open', vis.item); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (req.query.tag) { // an alias or case variant finds the same items, older ones and unregistered tags included
      const want = tagKey(canonicalTag(req.query.tag)?.tag);
      rows = rows.filter((i) => canonicalTags(P(i.tags)).some((t) => tagKey(t) === want));
    }
    res.json(rows.filter(vis.item).map((i) => itemJson(i, vis)));
  });

  r.get('/items/:code', can('read'), (req, res) => {
    const vis = view(req, res);
    if (!vis) return;
    const item = itemByCode(req.params.code, vis);
    item ? res.json(itemJson(item, vis)) : res.status(404).json({ error: 'no such item' });
  });

  // By the printed number. Close, reopen, or snooze: {"status":"done"} | {"status":"open"} | {"status":"snoozed","until":"2026-10-23"}.
  // Edit, with or without a status: {"due":"2026-10-23","due_time":"14:00","assignee":"Jen","text":"…"}; null or "" clears.
  r.post('/items/:code', can('write'), (req, res) => {
    const vis = view(req, res);
    if (!vis) return;
    const item = itemByCode(req.params.code, vis);
    if (!item) return res.status(404).json({ error: 'no such item' });
    const body = req.body || {};
    const { status, until, note } = body;
    const edits = Object.fromEntries(EDITABLE.filter((k) => k in body).map((k) => [k, body[k]]));
    if (status === undefined && !Object.keys(edits).length) return res.status(400).json({ error: `send a status and/or any of ${EDITABLE.join(', ')}` });
    if (status !== undefined && !['done', 'dropped', 'open', 'snoozed'].includes(status)) return res.status(400).json({ error: 'status must be done|dropped|open|snoozed' });
    if (status === 'snoozed' && !isDate(until)) return res.status(400).json({ error: 'snoozed needs until=YYYY-MM-DD' });
    try { editItem(item.id, edits, req.client.client); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (status !== undefined) setItemStatus(item.id, status, req.client.client, note || null, status === 'snoozed' ? until : null);
    refreshItemOutputs([item.id]);
    res.json(itemJson(db.prepare('SELECT * FROM items WHERE id=?').get(item.id), vis));
  });

  r.get('/open-loops.md', can('read'), (req, res) => {
    const vis = view(req, res);
    if (vis) res.type('text/markdown').send(renderOpenLoops(vis));
  });

  // The digest is one text over all work, so a client that may not see restricted work doesn't get it.
  const wholeDigest = (req, res, next) => (req.client.sensitivity === 'all' ? next()
    : res.status(403).json({ error: 'the digest covers all work; it isn\'t available at sensitivity normal' }));

  r.get('/digest/today', can('read'), wholeDigest, (_req, res) => {
    const f = path.join(paths.out, `digest-${localDate()}.md`);
    const latest = path.join(paths.out, 'digest-latest.md');
    if (fs.existsSync(f)) return res.type('text/markdown').send(fs.readFileSync(f, 'utf8'));
    if (fs.existsSync(latest)) return res.type('text/markdown').send(`<!-- stale: no digest yet today -->\n${fs.readFileSync(latest, 'utf8')}`);
    res.status(404).send('no digest yet');
  });

  // A day's notes: the day file, or for sensitivity normal, the same markdown rendered without restricted pages.
  const dayNotes = (date, vis) => {
    if (!vis.all) return renderDay(date, vis);
    const f = dayFilePath(date);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  };

  // /notes?from=2026-10-12&to=2026-10-16  (defaults: last 3 days) → concatenated markdown
  r.get('/notes', can('read'), (req, res) => {
    const to = req.query.to || localDate();
    const from = req.query.from || (isDate(to) ? addDays(to, -2) : to);
    if (!isDate(from) || !isDate(to)) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
    if (from > to || addDays(from, 366) < to) return res.status(400).json({ error: 'from..to must be a range of at most a year' });
    const vis = view(req, res);
    if (!vis) return;
    const parts = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const md = dayNotes(d, vis);
      if (md) parts.push(md);
    }
    res.type('text/markdown').send(parts.join('\n\n---\n\n') || `no notes ${from}..${to}`);
  });

  r.get('/notes/:date', can('read'), (req, res) => {
    if (!isDate(req.params.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const vis = view(req, res);
    if (!vis) return;
    const md = dayNotes(req.params.date, vis);
    md ? res.type('text/markdown').send(md) : res.status(404).send('none');
  });

  r.get('/search', can('read'), (req, res) => {
    const vis = view(req, res);
    if (!vis) return;
    const q = `%${req.query.q || ''}%`;
    res.json(db.prepare(`SELECT p.id, p.tags, p.page_date, d.name, p.page_index, p.summary FROM pages p JOIN documents d ON d.id=p.doc_id
      WHERE p.transcription_md LIKE ? ORDER BY p.page_date DESC`).all(q).filter(vis.page).slice(0, 50)
      .map(({ page_date, name, page_index, summary }) => ({ page_date, name, page_index, summary })));
  });

  // ?since=today | YYYY-MM-DD | ISO time (default: the last 24 hours) &client=mayer &after=<event id>
  // At most 1,000 events, oldest first. X-More: true means there are more: ask again with after=<the last id>.
  r.get('/events', can('read'), (req, res) => {
    const since = parseSince(req.query.since);
    if (!since) return res.status(400).json({ error: 'since must be "today", YYYY-MM-DD, or an ISO time' });
    const { client, after } = req.query;
    if (client !== undefined && typeof client !== 'string') return res.status(400).json({ error: 'give one client' });
    if (after !== undefined && !/^\d+$/.test(after)) return res.status(400).json({ error: 'after must be an event id' });
    const vis = view(req, res);
    if (!vis) return;
    const { events, more } = listEvents({ since, client, after: Number(after ?? 0) }, vis);
    res.set('X-More', String(more)).json(events);
  });

  r.post('/ingest', can('ingest'), (req, res) => {
    if (busy()) return res.status(409).json({ error: `busy: ${busy()}` });
    const mode = req.body?.mode === 'batch' ? 'batch' : 'sync';
    exclusive(`ingest:${mode}`, () => ingest({ mode })).catch((e) => console.error('[api] ingest failed:', e.message));
    res.status(202).json({ started: `ingest:${mode}` });
  });

  r.post('/digest', can('digest'), wholeDigest, async (req, res) => {
    try { const d = await morningDigest({ push: !!req.body?.push }); res.type('text/markdown').send(d.md); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Run details and page counts can describe restricted pages, so sensitivity normal gets counts of what it may see
  // and runs without their details.
  r.get('/status', can('read'), (req, res) => {
    const vis = view(req, res);
    if (!vis) return;
    const runs = db.prepare('SELECT kind, started_at, ended_at, ok, substr(detail,1,300) AS detail FROM runs ORDER BY id DESC LIMIT 10').all();
    const pages = new Map();
    for (const p of db.prepare('SELECT id, tags, status FROM pages').all().filter(vis.page)) pages.set(p.status, (pages.get(p.status) ?? 0) + 1);
    res.json({
      busy: busy(),
      runs: vis.all ? runs : runs.map(({ detail, ...run }) => run),
      pages: [...pages].map(([status, n]) => ({ status, n })),
      usage30d: db.prepare(`SELECT model, purpose, batch, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
        SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write FROM usage WHERE at >= datetime('now','-30 days') GROUP BY 1,2,3`).all(),
    });
  });

  return r;
}

// /api skips Umbrel's login (PROXY_AUTH_WHITELIST), so without a token it stays closed rather than open.
function apiAuth(req, res, next) {
  if (!apiEnabled()) return res.status(503).json({ error: 'no API tokens yet: create one with `node src/cli.js token add`; /api is disabled until then' });
  const client = authenticate(req.headers.authorization);
  if (!client) return res.status(401).json({ error: 'unauthorized' });
  req.client = client;
  next();
}

export function startServer() {
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', apiAuth, router());
  app.use('/ui-api', (req, _res, next) => { req.client = UI_CLIENT; next(); }, router());
  app.use(express.static(PUBLIC));
  const server = app.listen(config.server.port, () => console.log(`[server] listening on :${server.address().port}`));
  if (!apiEnabled()) console.warn('[server] no API tokens — /api is disabled; the browser UI still works');
  return server;
}
