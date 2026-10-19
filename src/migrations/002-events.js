// The audit trail (spec §1.3): one row per field an item mutation changed, with who changed it. `client` is
// handwriting, erased, ui, cli, legacy, or an API token's client name. `field` is an item column, or "created".
export const id = '002-events';

export function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  client TEXT NOT NULL,
  item_code INTEGER,
  field TEXT NOT NULL,
  old TEXT,
  new TEXT
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE INDEX IF NOT EXISTS events_item ON events(item_code);
`);
}
