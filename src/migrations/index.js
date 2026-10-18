// Numbered schema migrations. Each runs once, in order and in its own transaction, and is recorded in
// schema_migrations. They only add tables, columns and indexes, so an older database upgrades in place.
// Never edit one that has shipped; add the next number instead.
import * as m001 from './001-baseline-v0.1.4.js';

export const MIGRATIONS = [m001];

/**
 * Apply every migration this database hasn't recorded. Returns the ids applied. Each one takes the write lock first
 * (an immediate transaction) and re-checks the record under it, so the service and a `docker exec … cli.js` that
 * start together on a new release can't both run the same migration.
 */
export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const recorded = db.prepare('SELECT 1 FROM schema_migrations WHERE id=?');
  const record = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
  const applied = [];
  for (const m of MIGRATIONS) {
    if (recorded.get(m.id)) continue;
    const ran = db.transaction(() => {
      if (recorded.get(m.id)) return false; // another process got there first
      m.up(db);
      record.run(m.id, new Date().toISOString());
      return true;
    }).immediate();
    if (ran) applied.push(m.id);
  }
  return applied;
}
