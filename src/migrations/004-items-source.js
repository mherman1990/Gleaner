// Where an item came from: "handwriting" (every item before this, and every one a page makes) or what an API client
// named when it created one ("email", "artifact", …), with that source's own id for it (source_ref), so the same
// source item sent twice is one item. Only handwritten items are dropped when their line is erased.
export const id = '004-items-source';

export function up(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(items)').all().map((c) => c.name));
  if (!cols.has('source')) db.exec(`ALTER TABLE items ADD COLUMN source TEXT NOT NULL DEFAULT 'handwriting'`);
  if (!cols.has('source_ref')) db.exec('ALTER TABLE items ADD COLUMN source_ref TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS items_source_ref ON items(source, source_ref) WHERE source_ref IS NOT NULL');
}
