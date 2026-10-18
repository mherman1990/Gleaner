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
 * - A page is hidden whole if any of its tags is a restricted project. Aliases and case variants count, so tags
 *   stored before the registry existed are caught too.
 * - An item is hidden if any of its tags is restricted, or if it's mentioned on a hidden page.
 * With no registry nothing can be judged, so "normal" throws NoRegistryError and the caller answers 503: a typo in
 * projects.yaml must never open restricted work up.
 */
export function visibility(sensitivity, r = currentRegistry()) {
  if (sensitivity === 'all') return ALL;
  if (!r) throw new NoRegistryError('no project registry is loaded, so restricted work can\'t be filtered out');
  const restricted = new Set(r.projects.filter((p) => p.sensitivity === 'restricted').map((p) => tagKey(p.tag)));
  const restrictedTags = (tags) => canonicalTags(Array.isArray(tags) ? tags : P(tags), r).some((t) => restricted.has(tagKey(t)));

  const hiddenPages = new Set(db.prepare('SELECT id, tags FROM pages').all().filter((p) => restrictedTags(p.tags)).map((p) => p.id));
  const hiddenItems = new Set();
  for (const m of db.prepare('SELECT item_id, page_id FROM item_mentions').all()) if (hiddenPages.has(m.page_id)) hiddenItems.add(m.item_id);
  const hiddenCodes = new Set();
  for (const i of db.prepare('SELECT id, code, tags FROM items').all()) {
    if (restrictedTags(i.tags)) hiddenItems.add(i.id);
    if (hiddenItems.has(i.id)) hiddenCodes.add(i.code);
  }
  return {
    all: false,
    page: (p) => !hiddenPages.has(p.id),
    item: (i) => !hiddenItems.has(i.id),
    code: (code) => !hiddenCodes.has(Number(code)),
    restrictedTags,
  };
}
