// The sensitivity filter (spec §1.2). A client with sensitivity "normal" never sees restricted work: every route
// that returns items, pages, mentions, events or counts asks visibility() and drops what it hides. The API enforces
// this; prompts and clients don't have to.
import { db, P } from './db.js';
import { currentRegistry, canonicalTags, tagKey } from './registry.js';

export class NoRegistryError extends Error {}

/** Everything visible, for a client with sensitivity "all". */
export const ALL = Object.freeze({ all: true, page: () => true, item: () => true, code: () => true, restrictedTags: () => false });

/**
 * What a client with this sensitivity may see, judged now against the current registry.
 * - A restricted page has, or ever had, a restricted project among its tags (page_tags keeps every read's tags, so a
 *   re-read that misses the tag, or the page erased and written over, doesn't clear it).
 * - A restricted item has, or ever had, a restricted project among its tags (the events keep its tag history), or is
 *   mentioned on a restricted page, or was written from a restricted item (item_sources: the task written again as a
 *   new item, however many times). Aliases and case variants count, so tags stored before the registry existed are
 *   caught too.
 * - A page is hidden whole if it's restricted, or if it mentions, closes or snoozes a restricted item: its text holds
 *   that item's line or names it (an item tagged #mb on a widget page, one carried over from a restricted page, or
 *   "☑ <its line>").
 * - An item is hidden if it's restricted. Other items on a page hidden for its neighbour stay visible.
 * - Pages, items and item numbers this judgement didn't see (written by another process since) are hidden too. A
 *   route reads them and calls visibility() in one transaction (server.js), so it sees none.
 * With no registry nothing can be judged, so "normal" throws NoRegistryError and the caller answers 503: a typo in
 * projects.yaml must never open restricted work up.
 */
export function visibility(sensitivity, r = currentRegistry()) {
  if (sensitivity === 'all') return ALL;
  if (!r) throw new NoRegistryError('no project registry is loaded, so restricted work can\'t be filtered out');
  const restricted = new Set(r.projects.filter((p) => p.sensitivity === 'restricted').map((p) => tagKey(p.tag)));
  const restrictedTags = (tags) => canonicalTags(Array.isArray(tags) ? tags : P(tags), r).some((t) => restricted.has(tagKey(t)));

  const pages = db.prepare('SELECT id, tags FROM pages').all();
  const restrictedPages = new Set(pages.filter((p) => restrictedTags(p.tags)).map((p) => p.id));
  for (const t of db.prepare('SELECT page_id, tag FROM page_tags').all()) if (restrictedTags([t.tag])) restrictedPages.add(t.page_id);
  const mentions = db.prepare('SELECT item_id, page_id FROM item_mentions').all();
  const hadRestrictedTag = new Set(db.prepare(`SELECT item_code, old, new FROM events WHERE field='tags'`).all()
    .filter((e) => restrictedTags(e.old) || restrictedTags(e.new)).map((e) => e.item_code));
  const hiddenItems = new Set();
  for (const m of mentions) if (restrictedPages.has(m.page_id)) hiddenItems.add(m.item_id);
  const items = db.prepare('SELECT id, code, tags FROM items').all();
  for (const i of items) if (restrictedTags(i.tags) || hadRestrictedTag.has(i.code)) hiddenItems.add(i.id);
  const sources = db.prepare('SELECT item_id, source_id FROM item_sources').all();
  for (let grew = true; grew;) {
    grew = false;
    for (const s of sources) if (hiddenItems.has(s.source_id) && !hiddenItems.has(s.item_id)) { hiddenItems.add(s.item_id); grew = true; }
  }
  const hiddenCodes = new Set(items.filter((i) => hiddenItems.has(i.id)).map((i) => i.code));
  const hiddenPages = new Set(restrictedPages);
  for (const m of [...mentions, ...db.prepare('SELECT item_id, page_id FROM page_closes').all()]) {
    if (hiddenItems.has(m.item_id)) hiddenPages.add(m.page_id);
  }
  const shownPages = new Set(pages.map((p) => p.id).filter((id) => !hiddenPages.has(id)));
  const shownItems = new Set(items.map((i) => i.id).filter((id) => !hiddenItems.has(id)));
  const shownCodes = new Set(items.map((i) => i.code).filter((c) => !hiddenCodes.has(c)));
  return {
    all: false,
    page: (p) => shownPages.has(p.id),
    item: (i) => shownItems.has(i.id),
    code: (code) => shownCodes.has(Number(code)),
    restrictedTags,
  };
}
