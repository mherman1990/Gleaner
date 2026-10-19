// What a page has touched, kept for the sensitivity filter (src/sensitivity.js), so a later read of the page can't
// unhide work it once showed:
// - page_closes: each item a page closed or snoozed, by number ("✓14") or by a checked box on its line. Such a page
//   names the item without mentioning it.
// - page_tags: every tag a page has been read with. A re-read that misses a restricted tag, or a restricted page
//   erased and written over, stays restricted.
// - item_sources: an item written from another item's line (the task written again, as a new item), so restricted
//   work written again stays restricted whatever the registry or the pages say later.
// All three are only added to. And on item_mentions: gone_at, when a read found the line no longer on that page
// (erased or moved; the row stays, for the filter, and erasing an item drops it only when no page still has its line);
// linked_at, when the line was first linked to the page (a struck line older than the item's line on another page is
// its old copy); and mark, how the line was last read: ticked ("done"), struck ("dropped") or neither (null).
// For pages read before this migration, page_tags starts from each page's current tags, and page_closes from the
// close notation in its text: numbers after ✓, x, ✗, done, drop or snooze, or before ✓ or →
// (one, a list or a range: "✓14, 15", "✓ 14 15", "12 & 14 → Fri", "✓ 12–15"), linked to the items with those
// numbers (a page that only looks like it closes one is hidden too), and the words a handwriting close quoted as its
// evidence. A checked box that left no such trace can't be found. Existing lines count as on their page, linked on
// its date, and marked as their item when it was closed on its only page by its own line.
export const id = '003-page-history';

// 14 | 14, 15 | 14 15 | #14 & #15 | 14 and 15 | 14; 15 | 12–15
const NUMS = String.raw`#?\d{1,6}(?:(?:\s*(?:,|;|&|\+|\/|\band\b|[-–—])\s*|\s+)#?\d{1,6})*`;
const RANGE_MAX = 50; // a "range" wider than this is more likely two numbers than one close
/** Every number a NUMS match names: each of a list, and each in a range. */
function numbers(list) {
  const out = [];
  for (const m of list.matchAll(/(\d+)(?:\s*[-–—]\s*#?(\d+))?/g)) {
    const [a, b] = [Number(m[1]), m[2] === undefined ? null : Number(m[2])];
    if (b !== null && b > a && b - a <= RANGE_MAX) for (let n = a; n <= b; n++) out.push(n);
    else out.push(a, ...(b === null ? [] : [b]));
  }
  return out;
}
const TICK = String.raw`[✓✔☑✅]\uFE0F?`;
const CROSS = String.raw`[xX✗✘×✖❌☒]\uFE0F?`;
const CLOSE_REFS = [
  new RegExp(String.raw`${TICK}\s*(${NUMS})(?!\d)`, 'gu'), // ✓14, ✔️ 14, 15
  new RegExp(String.raw`(?<![\p{L}\d#])(${NUMS})\s*${TICK}`, 'gu'), // 14 ✓
  new RegExp(String.raw`(?<![\p{L}\d])${CROSS}\s*(${NUMS})(?!\d)`, 'gu'), // x14, ✗14
  new RegExp(String.raw`(?<![\p{L}\d])(?:done|drop|dropped|snooze)\s*:?\s+(${NUMS})(?!\d)`, 'giu'), // done 14, drop 14, snooze 14 Fri
  new RegExp(String.raw`(?<![\p{L}\d#])(${NUMS})\s*(?:→|->)`, 'gu'), // 14 → Fri, 12, 14 → Fri
];
// What Gleaner itself writes as close_evidence, which names no page.
const OWN_EVIDENCE = ['marked on source page', 'checked on page', 'no longer on source page'];

export function up(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS page_closes (
  page_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (page_id, item_id)
);
CREATE INDEX IF NOT EXISTS page_closes_item ON page_closes(item_id);
CREATE TABLE IF NOT EXISTS page_tags (
  page_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (page_id, tag)
);
CREATE TABLE IF NOT EXISTS item_sources (
  item_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY (item_id, source_id)
);
`);
  const cols = new Set(db.prepare('PRAGMA table_info(item_mentions)').all().map((c) => c.name));
  if (!cols.has('gone_at')) db.exec('ALTER TABLE item_mentions ADD COLUMN gone_at TEXT');
  if (!cols.has('linked_at')) {
    db.exec('ALTER TABLE item_mentions ADD COLUMN linked_at TEXT');
    db.exec('UPDATE item_mentions SET linked_at = page_date');
  }
  if (!cols.has('mark')) {
    db.exec('ALTER TABLE item_mentions ADD COLUMN mark TEXT');
    // What Gleaner wrote when a line's own tick or strike closed its item. On an item with lines on more than one page,
    // which line it was isn't known.
    db.exec(`UPDATE item_mentions SET mark = (SELECT status FROM items WHERE id = item_mentions.item_id)
      WHERE item_id IN (SELECT id FROM items WHERE status IN ('done', 'dropped') AND closed_by = 'handwriting'
        AND close_evidence IN ('marked on source page', 'checked on page'))
      AND (SELECT COUNT(*) FROM item_mentions o WHERE o.item_id = item_mentions.item_id) = 1`);
  }
  const addTag = db.prepare('INSERT OR IGNORE INTO page_tags (page_id, tag) VALUES (?, ?)');
  const addClose = db.prepare('INSERT OR IGNORE INTO page_closes (page_id, item_id) VALUES (?, ?)');
  const byCode = new Map(db.prepare('SELECT id, code FROM items WHERE code IS NOT NULL').all().map((i) => [i.code, i.id]));
  const quoted = db.prepare(`SELECT id, close_evidence FROM items WHERE closed_by='handwriting' AND close_evidence IS NOT NULL`).all()
    .map((i) => ({ id: i.id, words: i.close_evidence.trim().toLowerCase() }))
    .filter((i) => i.words.length >= 6 && !OWN_EVIDENCE.includes(i.words));

  for (const p of db.prepare('SELECT id, tags, transcription_md FROM pages').all()) {
    let tags = [];
    try { tags = JSON.parse(p.tags || '[]'); } catch { /* unreadable: nothing to add */ }
    for (const t of Array.isArray(tags) ? tags : []) if (typeof t === 'string' && t.trim()) addTag.run(p.id, t);

    const text = p.transcription_md || '';
    for (const re of CLOSE_REFS) {
      for (const m of text.matchAll(re)) for (const n of numbers(m[1])) if (byCode.has(n)) addClose.run(p.id, byCode.get(n));
    }
    const lower = text.toLowerCase();
    for (const i of quoted) if (lower.includes(i.words)) addClose.run(p.id, i.id);
  }
}
