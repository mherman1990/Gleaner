// The item-source adapter for API clients: the second kind of adapter (see bundle.js). Notebook sources hand the
// pipeline pages; this one hands the ledger single items, which POST /api/items asks for. Each request is a row in
// the inbox table, applied through the same ledger function as a new handwritten line's dedupe (upsertCandidate),
// so an item already open isn't added twice.
//   enqueue(payload, {client, sensitivity, source, sourceRef}) → { id, done }: records the request; done settles
//                            with the ledger's answer.
//   preview(payload, …)      → what it would do (dry run), writing nothing.
//   drain()                  → applies requests still pending or failed (a restart, an outage); run by each ingest.
//   doctor()                 → counts by status, and the last error.
import { db, now, J } from '../db.js';
import { upsertCandidate } from '../pipeline/ledger.js';
import { visibility } from '../sensitivity.js';

const MAX_ATTEMPTS = 3;
const running = new Map(); // inbox id → its promise, so a drain doesn't apply a request still being applied

/** The item fields a client may send, as upsertCandidate takes them. */
const fields = (p) => ({ text: p.text, kind: p.kind, person: p.person, assignee: p.assignee, due: p.due, due_time: p.due_time, priority: p.priority, tags: p.tags });

// For a client that may not see restricted work, the items the dedupe may not match: a match would change a hidden
// item and tell the client it exists. Judged when the request is applied, against the current registry.
const hiddenFrom = (sensitivity) => {
  if (sensitivity === 'all') return new Set();
  const vis = visibility(sensitivity);
  return new Set(db.prepare('SELECT id FROM items').all().filter((i) => !vis.item(i)).map((i) => i.id));
};

function apply(id) {
  if (running.has(id)) return running.get(id);
  const row = db.prepare('SELECT * FROM inbox WHERE id=?').get(id);
  if (!row || row.status === 'done') return Promise.resolve(row && { result: row.result, code: row.item_code });
  const work = (async () => {
    db.prepare('UPDATE inbox SET attempts=attempts+1 WHERE id=?').run(id);
    try {
      const out = await upsertCandidate(fields(JSON.parse(row.payload)),
        { client: row.client, source: row.source, sourceRef: row.source_ref, exclude: hiddenFrom(row.sensitivity) });
      db.prepare(`UPDATE inbox SET status='done', result=?, item_code=?, error=NULL WHERE id=?`).run(out.result, out.code, id);
      return out;
    } catch (e) {
      db.prepare(`UPDATE inbox SET status='failed', error=? WHERE id=?`).run(String(e.message || e).slice(0, 500), id);
      throw e;
    } finally {
      running.delete(id);
    }
  })();
  running.set(id, work);
  return work;
}

/**
 * Record a create request and start applying it. payload: the item fields; client and sensitivity: the API
 * client's; source/sourceRef: where the item came from.
 */
export function enqueue(payload, { client, sensitivity = 'all', source, sourceRef = null }) {
  const { lastInsertRowid } = db.prepare('INSERT INTO inbox (at, client, sensitivity, source, source_ref, payload) VALUES (?,?,?,?,?,?)')
    .run(now(), client, sensitivity, source, sourceRef, J(payload));
  const id = Number(lastInsertRowid);
  return { id, done: apply(id) };
}

/** What a request would do, with nothing written: "would_create", or "would_merge" with the item's number. */
export function preview(payload, { client, sensitivity = 'all', source, sourceRef = null }) {
  return upsertCandidate(fields(payload), { client, source, sourceRef, dryRun: true, exclude: hiddenFrom(sensitivity) });
}

/** Apply every request still pending or failed (fewer than MAX_ATTEMPTS tries). Returns how many were applied. */
export async function drain() {
  let applied = 0;
  for (const { id } of db.prepare(`SELECT id FROM inbox WHERE status IN ('pending', 'failed') AND attempts < ? ORDER BY id`).all(MAX_ATTEMPTS)) {
    try { await apply(id); applied++; } catch { /* kept as failed, with its error */ }
  }
  return applied;
}

export function doctor() {
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM inbox GROUP BY status').all().map((r) => [r.status, r.n]));
  const failed = db.prepare(`SELECT id, error FROM inbox WHERE status='failed' ORDER BY id DESC LIMIT 1`).get();
  return { ...counts, ...(failed ? { lastError: `#${failed.id}: ${failed.error}` } : {}) };
}
