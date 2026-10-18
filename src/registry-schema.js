// The project registry's format and lookups, with no I/O and no config, so it also runs outside the container
// (scripts/check-registry.mjs). src/registry.js loads the file and supplies the current registry.
//
// The file is read with YAML's failsafe schema: every scalar stays the text that was written, so an alias such as
// 1.10 or 0707 is matched as written, never as a number. Only `notebook` is read as true/false.
import crypto from 'node:crypto';
import YAML from 'yaml';

const STATUS = ['active', 'watch', 'on-hold', 'closed'];
const SENSITIVITY = ['normal', 'restricted'];
const FUNDING = ['checkoff', 'non-checkoff', 'mixed'];
// The keys each level reads. Any other key is ignored with a warning, so a typo such as `alias:` can't silently drop
// what it was meant to hold.
const KEYS = {
  top: ['version', 'programs', 'projects', 'people', 'contexts'],
  program: ['name', 'description'],
  project: ['tag', 'name', 'aliases', 'program', 'status', 'sensitivity', 'notebook', 'funding', 'people', 'search'],
  search: ['email', 'calendar', 'teams'],
  person: ['name', 'write_as'],
};

/** How a tag or name is compared: without leading #s and outer spaces, case-insensitive. */
export const key = (s) => String(s ?? '').trim().replace(/^#+\s*/, '').toLowerCase();
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNull = (v) => v === undefined || v === null || (typeof v === 'string' && /^(|~|null|Null|NULL)$/.test(v.trim()));
const bare = (s) => s.replace(/^#+\s*/, ''); // "#kite" in the file means the tag kite

export class RegistryError extends Error {
  constructor(errors, warnings = []) { super(errors.join('; ')); this.errors = errors; this.warnings = warnings; }
}

/** Parse and validate registry text. Returns the registry; throws a RegistryError listing every structural error. */
export function parseRegistry(text) {
  const errors = [], warnings = [];
  let doc;
  try { doc = YAML.parse(text, { schema: 'failsafe' }); }
  catch (e) { throw new RegistryError([`not valid YAML: ${e.message.split('\n')[0]}`]); }
  if (!isMap(doc)) throw new RegistryError(['the file must be a mapping with a projects: list']);

  /** One scalar field as trimmed text ('' when null or absent); a list or mapping there is an error. */
  const text1 = (v, where) => {
    if (isNull(v)) return '';
    if (typeof v !== 'string') { errors.push(`${where} must be a single value, not a list or mapping`); return ''; }
    return v.trim();
  };
  const list = (v, where) => (isNull(v) ? [] : Array.isArray(v) ? v : (errors.push(`${where} must be a list`), []));
  const strings = (v, where) => list(v, where).map((x, i) => {
    const s = text1(x, `${where}[${i}]`);
    if (!s && isNull(x)) warnings.push(`${where}[${i}] is empty (ignored). An unquoted # starts a YAML comment: write "#x" in quotes, or leave the # out`);
    return s;
  }).filter(Boolean);
  const tagStrings = (v, where) => strings(v, where).map(bare).filter(Boolean);
  const unknownKeys = (m, allowed, where) => {
    for (const k of Object.keys(m)) if (!allowed.includes(k)) warnings.push(`${where}unknown key "${k}" (ignored)`);
  };

  unknownKeys(doc, KEYS.top, '');
  const version = text1(doc.version, 'version');
  if (version && Number(version) !== 1) warnings.push(`version ${version}: this Gleaner reads version 1`);
  if (!isNull(doc.programs) && !isMap(doc.programs)) errors.push('programs must be a mapping');
  const programs = isMap(doc.programs) ? doc.programs : {};
  for (const [k, v] of Object.entries(programs)) if (isMap(v)) unknownKeys(v, KEYS.program, `programs.${k}: `);
  if (!Array.isArray(doc.projects)) errors.push('projects must be a list');

  const projects = [];
  for (const [i, p] of (Array.isArray(doc.projects) ? doc.projects : []).entries()) {
    if (!isMap(p)) { errors.push(`projects[${i}] must be a mapping`); continue; }
    const tag = bare(text1(p.tag, `projects[${i}].tag`));
    const where = tag || `projects[${i}]`;
    if (!tag) errors.push(`${where}: tag is required`);
    unknownKeys(p, KEYS.project, `${where}: `);
    const name = text1(p.name, `${where}: name`);
    if (!name) errors.push(`${where}: name is required`);
    const status = text1(p.status, `${where}: status`) || 'active';
    if (!STATUS.includes(status)) errors.push(`${where}: status must be one of ${STATUS.join(', ')}`);
    const sensitivity = text1(p.sensitivity, `${where}: sensitivity`);
    if (!SENSITIVITY.includes(sensitivity)) errors.push(`${where}: sensitivity must be normal or restricted`);
    const notebook = text1(p.notebook, `${where}: notebook`);
    if (notebook && !/^(true|false)$/i.test(notebook)) errors.push(`${where}: notebook must be true or false`);
    const program = text1(p.program, `${where}: program`) || null;
    if (program && !(program in programs)) warnings.push(`${where}: program "${program}" isn't listed under programs`);
    const funding = text1(p.funding, `${where}: funding`) || null;
    if (funding && !FUNDING.includes(funding)) warnings.push(`${where}: funding "${funding}" isn't one of ${FUNDING.join(', ')}`);
    if (!isNull(p.search) && !isMap(p.search)) warnings.push(`${where}: search should be a mapping of email/calendar/teams lists`);
    const search = isMap(p.search) ? p.search : {};
    unknownKeys(search, KEYS.search, `${where}: search: `);
    projects.push({
      tag, name, aliases: tagStrings(p.aliases, `${where}: aliases`), program, status, sensitivity,
      notebook: /^true$/i.test(notebook), funding, people: strings(p.people, `${where}: people`),
      search: {
        email: strings(search.email, `${where}: search.email`),
        calendar: strings(search.calendar, `${where}: search.calendar`),
        teams: strings(search.teams, `${where}: search.teams`),
      },
    });
  }

  // Every tag and alias must name exactly one project. Tags first, so a clash is reported against the tag.
  const keys = new Map(); // key -> canonical tag
  for (const p of projects) {
    if (!p.tag) continue;
    if (keys.has(key(p.tag))) errors.push(`duplicate tag "${p.tag}"`);
    else keys.set(key(p.tag), p.tag);
  }
  for (const p of projects) {
    for (const a of p.aliases) {
      const owner = keys.get(key(a));
      if (owner === undefined) keys.set(key(a), p.tag);
      else if (owner === p.tag) warnings.push(`${p.tag}: alias "${a}" is listed twice or repeats the tag`);
      else errors.push(`alias "${a}" of ${p.tag} is already a tag or alias of ${owner}`);
    }
  }

  const contexts = [];
  for (const c of tagStrings(doc.contexts, 'contexts')) {
    if (contexts.some((x) => key(x) === key(c))) warnings.push(`context "${c}" is listed twice`);
    else contexts.push(c);
  }
  for (const c of contexts) if (keys.has(key(c))) errors.push(`context "${c}" is also a project tag or alias`);

  const people = [], names = new Map(), firstNames = new Map();
  for (const [i, p] of list(doc.people, 'people').entries()) {
    const name = isMap(p) ? text1(p.name, `people[${i}].name`) : '';
    if (!name) { errors.push(`people[${i}]: name is required`); continue; }
    unknownKeys(p, KEYS.person, `${name}: `);
    if (names.has(key(name))) errors.push(`person "${name}" is listed twice`);
    names.set(key(name), name);
    people.push({ name, write_as: strings(p.write_as, `people[${i}]: write_as`) });
    const first = key(name.split(/\s+/)[0]);
    firstNames.set(first, new Set([...(firstNames.get(first) || []), name]));
  }
  for (const p of people) {
    for (const w of p.write_as) {
      const owner = names.get(key(w));
      if (owner === undefined) names.set(key(w), p.name);
      else if (owner !== p.name) errors.push(`write_as "${w}" of ${p.name} already means ${owner}`);
    }
  }

  if (errors.length) throw new RegistryError(errors, warnings);
  return {
    version: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12),
    programs, projects, people, contexts, warnings,
    keys, byTag: new Map(projects.map((p) => [p.tag, p])), names, firstNames,
    contextKeys: new Map(contexts.map((c) => [key(c), c])),
  };
}

/**
 * A tag as stored: an alias or case variant becomes the canonical tag; an unknown tag is kept as written, minus
 * leading #s. Without a registry (r null) every tag is kept as written. null for an empty tag.
 */
export function canonicalTag(raw, r) {
  const k = key(raw);
  if (!k) return null;
  const asWritten = String(raw).trim().replace(/^#+\s*/, '');
  if (!r) return { tag: asWritten, registered: false };
  if (r.keys.has(k)) return { tag: r.keys.get(k), registered: true };
  if (r.contextKeys.has(k)) return { tag: r.contextKeys.get(k), registered: true, context: true };
  return { tag: asWritten, registered: false };
}

/** Canonical tags for a list, in order. Case variants of one tag collapse to the first spelling. */
export function canonicalTags(tags, r) {
  const out = new Map();
  for (const t of Array.isArray(tags) ? tags : []) {
    const c = canonicalTag(t, r);
    if (c && !out.has(key(c.tag))) out.set(key(c.tag), c.tag);
  }
  return [...out.values()];
}

/** The tags in a list that no project, alias or context covers, as stored (deduplicated). Empty without a registry. */
export function unregisteredTags(tags, r) {
  if (!r) return [];
  return canonicalTags(tags, r).filter((t) => !canonicalTag(t, r).registered);
}

/**
 * A person as stored. A full name or a write_as form gives the registry name (known). A bare first name shared by
 * two or more registry people stays as written and is ambiguous. Anyone else is kept as written.
 */
export function resolvePerson(raw, r) {
  const s = String(raw ?? '').trim();
  if (!s) return { name: null, known: false, ambiguous: false };
  if (!r) return { name: s, known: false, ambiguous: false };
  if (r.names.has(key(s))) return { name: r.names.get(key(s)), known: true, ambiguous: false };
  return { name: s, known: false, ambiguous: (r.firstNames.get(key(s))?.size ?? 0) > 1 };
}

/**
 * Whether a name is only the first name of the registry person another name means: "Alex" of "Alex Two", or of
 * "Alex T" when that's Alex Two's write_as form. A name that is itself a registry person ("Alex", listed) is not.
 */
export function isFirstNameOf(raw, name, r) {
  const person = resolvePerson(name, r);
  return person.known && !resolvePerson(raw, r).known && !!r.firstNames.get(key(raw))?.has(person.name);
}

/**
 * person_ambiguous for an item: its person or assignee is a first name two registry people share. Worked out from
 * the stored names and the current registry each time, so it can't go stale when either changes.
 */
export const personAmbiguous = (item, r) =>
  resolvePerson(item?.person, r).ambiguous || resolvePerson(item?.assignee, r).ambiguous;

/** The registry section of the transcription prompt. Stable for a given file, so the prompt cache keeps hitting. */
export function promptBlock(r) {
  const lines = ['PROJECT TAGS (canonical tag: what it covers; the other forms are aliases that mean the same tag)'];
  for (const p of r.projects) lines.push(`- ${p.tag}: ${p.name}${p.aliases.length ? ` (also written: ${p.aliases.join(', ')})` : ''}`);
  if (r.contexts.length) lines.push('', `CONTEXT TAGS (not projects; use as written): ${r.contexts.join(', ')}`);
  if (r.people.length) {
    lines.push('', 'PEOPLE (when the page uses one of these forms, write the full name)');
    for (const p of r.people) lines.push(`- ${[p.name, ...p.write_as].join(', ')} → ${p.name}`);
  }
  return lines.join('\n');
}
