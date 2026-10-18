// Which page closed or snoozed which item, by number ("✓14") or by a checked box on its line. Such a page names the
// item without mentioning it, so the sensitivity filter needs this link to hide a page that closes restricted work.
export const id = '003-page-closes';

export function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS page_closes (
  page_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (page_id, item_id)
);
CREATE INDEX IF NOT EXISTS page_closes_item ON page_closes(item_id);
`);
}
