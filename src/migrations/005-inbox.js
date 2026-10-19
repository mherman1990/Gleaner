// Items API clients asked to create (POST /api/items), one row per request: pending until applied, then done (with
// the item it created or merged into) or failed (retried at the next ingest, up to a few times). A request that
// outlasts the reply's time budget finishes from here. sensitivity is the client's, so a retry still can't merge
// into work the client may not see. See src/adapters/api-inbox.js.
export const id = '005-inbox';

export function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  client TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'all',
  source TEXT NOT NULL,
  source_ref TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  item_code INTEGER,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS inbox_status ON inbox(status);
CREATE INDEX IF NOT EXISTS inbox_source_ref ON inbox(source, source_ref);
`);
}
