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
import { config, paths, localDate, normTime } from './config.js';
import { db, P, listItems, setItemStatus, editItem, EDITABLE, isDate } from './db.js';
import { renderOpenLoops, renderDay, dayFilePath, refreshItemOutputs } from './output/markdown.js';
import { ingest } from './pipeline/ingest.js';
import { morningDigest, addDays } from './digest/digest.js';
import { busy, exclusive } from './jobs.js';
import { canonicalTag, canonicalTags, unregisteredTags, personAmbiguous, tagKey } from './registry.js';
import { authenticate, apiEnabled, UI_CLIENT } from './auth.js';
import { visibility, NoRegistryError } from './sensitivity.js';
import { listEvents, parseSince } from './events.js';
import { enqueue, preview } from './adapters/api-inbox.js';
import { projectList, projectDetail } from './projects.js';
import { healthReport } from './health.js';

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
  // A read answers from one snapshot of the database: visibility() and the rows it filters are read in one
  // transaction, so nothing another process (a `docker exec … cli.js ingest`) commits meanwhile can get past it.
  const get = (route, ...handlers) => r.get(route, ...handlers.slice(0, -1), (req, res) => db.transaction(() => handlers.at(-1)(req, res))());
  const itemByCode = (code, vis) => {
    const item = db.prepare('SELECT * FROM items WHERE code=?').get(Number(code));
    return item && vis.item(item) ? item : null;
  };

  // ?status=open (default) | snoozed | closed | all
  get('/items', can('read'), (req, res) => {
    const vis = view(req, res);
    if (!vis) return;
    // ?tag= takes an alias or case variant and finds older items and unregistered tags too. Like the sensitivity
    // filter, it applies before the list is capped, so a project's older closed items are still found.
    const want = req.query.tag ? tagKey(canonicalTag(req.query.tag)?.tag) : null;
    const keep = (i) => vis.item(i) && (want === null || canonicalTags(P(i.tags)).some((t) => tagKey(t) === want));
    let rows;
    try { rows = listItems(req.query.status || 'open', keep); } catch (e) { return res.status(400).json({ error: e.message }); }
    res.json(rows.map((i) => itemJson(i, vis)));
  });

  get('/items/:code', can('read'), (req, res) => {
    const vis = view(req, res);
    if (!vis) return;
    const item = itemByCode(req.params.code, vis);
    item ? res.json(itemJson(item, vis)) : res.status(404).json({ error: 'no such item' });
  });

  // By the printed number. Close, reopen, or snooze: {"status":"done"} | {"status":"open"} | {"status":"snoozed","until":"2026-10-23"}.
  // Edit, with or without a status: {"due":"2026-10-23","due_time":"14:00","assignee":"Jen","text":"…"}; null or "" clears.
  // The check that the client may see the item, the change, and the reply's row happen under one write lock, so an
  // item another process makes restricted meanwhile is neither changed nor returned.
  r.post('/items/:code', can('write'), (req, res) => {
    const changed = db.transaction(() => {
      const fail = (code, error) => { res.status(code).json({ error }); return null; };
      const vis = view(req, res);
      if (!vis) return null;
      const item = itemByCode(req.params.code, vis);
      if (!item) return fail(404, 'no such item');
      const body = req.body || {};
      const { status, until, note } = body;
      const edits = Object.fromEntries(EDITABLE.filter((k) => k in body).map((k) => [k, body[k]]));
      if (status === undefined && !Object.keys(edits).length) return fail(400, `send a status and/or any of ${EDITABLE.join(', ')}`);
      if (status !== undefined && !['done', 'dropped', 'open', 'snoozed'].includes(status)) return fail(400, 'status must be done|dropped|open|snoozed');
      if (status === 'snoozed' && !isDate(until)) return fail(400, 'snoozed needs until=YYYY-MM-DD');
      try { editItem(item.id, edits, req.client.client); } catch (e) { return fail(400, e.message); }
      if (status !== undefined) setItemStatus(item.id, status, req.client.client, note || null, status === 'snoozed' ? until : null);
      return { id: item.id, json: itemJson(db.prepare('SELECT * FROM items WHERE id=?').get(item.id), vis) };
    }).immediate();
    if (!changed) return;
    refreshItemOutputs([changed.id]);
    res.json(changed.json);
  });

  // Create an item. Only text is needed: {"text":"Send Jen the budget","due":"2026-10-23","due_time":"14:00",
  // "assignee":"Jen","person":"Jen","tags":["budget"],"priority":true,"kind":"followup","source":"email",
  // "source_ref":"<the source's own id>"}. It's checked against the open loops first: an item already open is filled
  // in ("merged", 200), not copied, and the same source and source_ref sent again changes nothing ("existing", 200),
  // even after that item is closed. Otherwise "created" (201). The answer comes within config.api.createBudgetSeconds,
  // else "queued" (202) and the item follows in the background (a failure is retried at each ingest for a week).
  // ?dry_run=1 answers "existing", "would_create" or "would_merge" and writes nothing.
  r.post('/items', can('create'), async (req, res) => {
    const vis = view(req, res);
    if (!vis) return;
    const b = req.body || {};
    const bad = (error) => res.status(400).json({ error });
    const str = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.trim().length <= max);
    if (typeof b.text !== 'string' || !b.text.trim() || b.text.trim().length > 300) return bad('text is required, at most 300 characters');
    if (b.kind !== undefined && !['action', 'followup', 'waiting', 'decision', 'idea', 'question'].includes(b.kind)) return bad('kind must be action|followup|waiting|decision|idea|question');
    if (!str(b.person, 60) || !str(b.assignee, 60)) return bad('person and assignee are names, at most 60 characters');
    if (b.due !== undefined && b.due !== null && !isDate(b.due)) return bad('due must be YYYY-MM-DD');
    if (b.due_time !== undefined && b.due_time !== null && !normTime(b.due_time)) return bad('due_time must be a time like 14:00 or 2pm');
    if (b.priority !== undefined && typeof b.priority !== 'boolean') return bad('priority must be true or false');
    if (b.tags !== undefined && !(Array.isArray(b.tags) && b.tags.length <= 10 && b.tags.every((t) => typeof t === 'string' && t.trim() && t.length <= 40))) return bad('tags must be a list of at most 10 short strings');
    const source = b.source ?? 'api';
    if (typeof source !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(source) || source === 'handwriting') return bad('source must be a short lowercase name, not "handwriting"');
    if (b.source_ref !== undefined && b.source_ref !== null && !(typeof b.source_ref === 'string' && b.source_ref.trim() && b.source_ref.length <= 200)) return bad('source_ref must be a string of at most 200 characters');
    const payload = { text: b.text.trim(), kind: b.kind, person: b.person?.trim() || null, assignee: b.assignee?.trim() || null, due: b.due || null,
      due_time: b.due_time || null, priority: !!b.priority, tags: (b.tags || []).map((t) => t.trim()) };
    const who = { client: req.client.client, sensitivity: req.client.sensitivity, source, sourceRef: b.source_ref ?? null };

    if (['1', 'true'].includes(String(req.query.dry_run))) {
      try {
        const out = await preview(payload, who);
        return res.json({ result: out.result, ...(out.code && vis.code(out.code) ? { code: out.code } : {}) });
      } catch (e) { return res.status(502).json({ error: `couldn't check against the open loops: ${e.message}` }); }
    }
    const { id: inboxId, done } = enqueue(payload, who);
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), config.api.createBudgetSeconds * 1000); });
    const out = await Promise.race([done, late]).catch(() => null);
    clearTimeout(timer);
    if (!out) { // still running, or failed: it finishes in the background, or at the next ingest
      done.then((o) => o && refreshItemOutputs([o.id]), () => {});
      return res.status(202).json({ result: 'queued', inbox_id: inboxId });
    }
    if (out.result !== 'existing') refreshItemOutputs([out.id]);
    const after = view(req, res);
    if (!after) return;
    // The item's number only if the client may see the item (one sent before by another client may be restricted).
    const item = itemByCode(out.code, after);
    res.status(out.result === 'created' ? 201 : 200).json({ result: out.result, ...(item ? { code: out.code, item: itemJson(item, after) } : {}) });
  });

  // The registry's projects with counts (open, waiting, overdue, carried_max, last_activity), and tags in use that the
  // registry doesn't cover. At sensitivity normal, restricted projects aren't listed and only visible work is counted.
  get('/projects', can('read'), (req, res) => {
    const vis = view(req, res);
    if (vis) res.json(projectList(vis));
  });

  // One project by its tag or an alias: open items by kind, waiting, decisions (90 days), questions, page summaries
  // and closes in the window. ?days=30 (1–365). 404 for a tag that isn't a project, or a restricted one at normal.
  get('/projects/:tag', can('read'), (req, res) => {
    const days = req.query.days === undefined ? 30 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) return res.status(400).json({ error: 'days must be a whole number from 1 to 365' });
    const vis = view(req, res);
    if (!vis) return;
    const out = projectDetail(req.params.tag, { days }, vis);
    if (!out) return res.status(404).json({ error: 'no such project' });
    const items = (list) => list.map((i) => itemJson(i, vis));
    res.json({ ...out, open: Object.fromEntries(Object.entries(out.open).map(([k, v]) => [k, items(v)])),
      waiting: items(out.waiting), decisions: items(out.decisions), questions: items(out.questions), closed: items(out.closed) });
  });

  // Jobs, the source's sign-in, pending pages, spend, memory, disk, registry and the health check's alerts.
  get('/health', can('read'), (req, res) => {
    const vis = view(req, res);
    if (vis) res.json(healthReport(vis));
  });

  get('/open-loops.md', can('read'), (req, res) => {
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
  get('/notes', can('read'), (req, res) => {
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

  get('/notes/:date', can('read'), (req, res) => {
    if (!isDate(req.params.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const vis = view(req, res);
    if (!vis) return;
    const md = dayNotes(req.params.date, vis);
    md ? res.type('text/markdown').send(md) : res.status(404).send('none');
  });

  get('/search', can('read'), (req, res) => {
    const vis = view(req, res);
    if (!vis) return;
    const q = `%${req.query.q || ''}%`;
    res.json(db.prepare(`SELECT p.id, p.tags, p.page_date, d.name, p.page_index, p.summary FROM pages p JOIN documents d ON d.id=p.doc_id
      WHERE p.transcription_md LIKE ? AND p.status NOT IN ('blank', 'deleted') ORDER BY p.page_date DESC`).all(q).filter(vis.page).slice(0, 50)
      .map(({ page_date, name, page_index, summary }) => ({ page_date, name, page_index, summary })));
  });

  // ?since=today | YYYY-MM-DD | ISO time (default: the last 24 hours) &client=mayer &after=<event id>
  // At most 1,000 events, oldest first. X-More: true means there are more: ask again with after=<the last id>.
  get('/events', can('read'), (req, res) => {
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
  get('/status', can('read'), (req, res) => {
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
