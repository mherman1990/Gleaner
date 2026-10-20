// The health check's state (src/health.js), one row per condition it watches: whether it held at the last check
// (checked_at), since when (first_seen), what was read (detail), and when an alert about it last reached a channel
// (last_sent). An alert is sent at most once per condition per health.alertEveryHours, and only a send a channel
// accepted counts, as for nudges. The service and a `docker exec … cli.js health --check` share it.
export const id = '006-alerts';

export function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS alerts (
  condition TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT,
  checked_at TEXT,
  last_sent TEXT,
  detail TEXT
);
`);
}
