// The item-source adapter for API clients: the second kind of adapter (see bundle.js). Notebook sources hand the
// pipeline pages; this one hands the ledger single items, which POST /api/items asks for. Each request is a row in
// the inbox table, applied through the same ledger function as a new handwritten line's dedupe (upsertCandidate),
// so an item already open isn't added twice.
//   enqueue(payload, {client, sensitivity, source, sourceRef}) → { id, done }: records the request; done settles
//                            with the ledger's answer.
//   preview(payload, …)      → what it would do (dry run), writing nothing.
//   drain()                  → applies requests still pending or failed (a restart, an outage) for up to a week;
//                            run by each ingest. Returns the items they changed.
//   doctor()                 → counts by status, and the last error.
import { db, now, J } from '../db.js';
import { upsertCandidate } from '../pipeline/ledger.js';
import { visibility } from '../sensitivity.js';

const RETRY_DAYS = 7; // an outage of a few days (an API key that ran out of credit) still ends with the item made
const CLAIM_MINUTES = 10; // a claim this old was a process that died mid-request: another may take it over
const running = new Map(); // inbox id → its promise, so a drain doesn't apply a request still being applied

/** The item fields a client may send, as upsertCandidate takes them. */
const fields = (p) => ({ text: p.text, kind: p.kind, person: p.person, assignee: p.assignee, due: p.due, due_time: p.due_time, priority: p.priority, tags: p.tags });

// For a client that may not see restricted work, the items the dedupe may not match: a match would change a hidden
// item and tell the client it exists. Judged when the request has its turn in the ledger, against the current registry.
const hiddenFrom = (sensitivity) => {
  if (sensitivity === 'all') return new Set();
  const vis = visibility(sensitivity);
  return new Set(db.prepare('SELECT id FROM items').all().filter((i) => !vis.item(i)).map((i) => i.id));
};

/**
 * Apply one request. Resolves with the ledger's answer, or null when another process (the service, or a `docker exec
 * … cli.js ingest`) has claimed it. upsertCandidate marks the row done in the same transaction as the item change, so
 * a request is never applied twice.
 */
function apply(id) {
  if (running.has(id)) return running.get(id);
  const row = db.prepare('SELECT * FROM inbox WHERE id=?').get(id);
  if (!row || row.status === 'done') return Promise.resolve(row && { result: row.result, code: row.item_code });
  const stale = new Date(Date.now() - CLAIM_MINUTES * 60e3).toISOString();
  const claimed = db.prepare(`UPDATE inbox SET status='applying', claimed_at=?, attempts=attempts+1 WHERE id=?
    AND (status IN ('pending', 'failed') OR (status='applying' AND claimed_at < ?))`).run(now(), id, stale).changes;
  if (!claimed) return Promise.resolve(null);
  const work = (async () => {
    try {
      return await upsertCandidate(fields(JSON.parse(row.payload)),
        { client: row.client, source: row.source, sourceRef: row.source_ref, inboxId: id, hidden: () => hiddenFrom(row.sensitivity) });
    } catch (e) {
      db.prepare(`UPDATE inbox SET status='failed', error=? WHERE id=? AND status != 'done'`).run(String(e.message || e).slice(0, 500), id);
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
  return upsertCandidate(fields(payload), { client, source, sourceRef, dryRun: true, hidden: () => hiddenFrom(sensitivity) });
}

/**
 * Apply every request from the last RETRY_DAYS still pending, failed, or claimed by a process that has since died.
 * Returns the ids of the items they changed.
 */
export async function drain() {
  const since = new Date(Date.now() - RETRY_DAYS * 864e5).toISOString();
  const stale = new Date(Date.now() - CLAIM_MINUTES * 60e3).toISOString();
  const changed = [];
  for (const { id } of db.prepare(`SELECT id FROM inbox WHERE at >= ? AND (status IN ('pending', 'failed') OR (status='applying' AND claimed_at < ?))
    ORDER BY id`).all(since, stale)) {
    try {
      const out = await apply(id);
      if (out?.id && out.result !== 'existing') changed.push(out.id);
    } catch { /* kept as failed, with its error */ }
  }
  return changed;
}

export function doctor() {
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM inbox GROUP BY status').all().map((r) => [r.status, r.n]));
  const failed = db.prepare(`SELECT id, error FROM inbox WHERE status='failed' ORDER BY id DESC LIMIT 1`).get();
  return { ...counts, ...(failed ? { lastError: `#${failed.id}: ${failed.error}` } : {}) };
}
