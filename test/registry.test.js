// The project registry: structural validation, alias and people lookups, hot reload with the saved last good copy,
// and the prompt block. All registry content in these tests is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempEnv } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'registry.yaml');
const dataDir = tempEnv('registry');
const file = path.join(dataDir, 'projects.yaml');
const { config } = await import('../src/config.js');
const { parseRegistry, currentRegistry, registryStatus, canonicalTag, canonicalTags, unregisteredTags, resolvePerson,
  isFirstNameOf, personAmbiguous, promptBlock } = await import('../src/registry.js');
const { transcribeSystem } = await import('../src/llm/prompts.js');

const fixture = fs.readFileSync(FIXTURE, 'utf8');
const errorsOf = (text) => { try { parseRegistry(text); return []; } catch (e) { return e.errors; } };
const project = (extra) => `projects:\n  - tag: a\n    name: A\n    sensitivity: normal\n${extra}`;

test('the fixture registry loads: TODOs, "# ?" and null funding pass; an unknown program only warns', () => {
  const r = parseRegistry(fixture);
  assert.match(r.version, /^[0-9a-f]{12}$/);
  assert.equal(r.projects.length, 4);
  assert.deepEqual(r.contexts, ['phone', 'desk', 'later']);
  assert.deepEqual(r.warnings, ['orchard: program "gamma" isn\'t listed under programs']);
  assert.equal(r.byTag.get('widget-report').funding, null);
  assert.equal(r.byTag.get('widget-report').notebook, true);
  assert.equal(r.byTag.get('orchard').notebook, false);
});

test('numbers are kept exactly as written, so 1.10 and 0707 match only themselves', () => {
  const r = parseRegistry(fixture);
  assert.deepEqual(r.byTag.get('bridge-permit').aliases, ['404', '1.10', '0707', 'bp']);
  assert.equal(canonicalTag('#1.10', r).tag, 'bridge-permit');
  assert.equal(canonicalTag('0707', r).tag, 'bridge-permit');
  assert.deepEqual(canonicalTag('1.1', r), { tag: '1.1', registered: false }, 'YAML did not turn 1.10 into 1.1');
  assert.deepEqual(canonicalTag('707', r), { tag: '707', registered: false });
  assert.equal(parseRegistry('projects:\n  - tag: 007\n    name: Bond\n    sensitivity: normal\n').projects[0].tag, '007');
});

test('structural errors fail validation, every one reported in a single pass', () => {
  assert.match(errorsOf('projects: [\n')[0], /not valid YAML/);
  assert.deepEqual(errorsOf('- just a list'), ['the file must be a mapping with a projects: list']);
  assert.deepEqual(errorsOf(`projects:\n  - tag: a\n    name: A\n    sensitivity: normal\n  - tag: A\n    name: B\n    sensitivity: normal\n`), ['duplicate tag "A"']);
  assert.deepEqual(errorsOf(project('    status: done\n')), ['a: status must be one of active, watch, on-hold, closed']);
  assert.deepEqual(errorsOf(project('    notebook: maybe\n')), ['a: notebook must be true or false']);
  assert.deepEqual(errorsOf(project('    aliases: [b: c]\n')), ['a: aliases[0] must be a single value, not a list or mapping'], 'a mistyped flow pair');
  assert.deepEqual(errorsOf('projects:\n  - tag: [x, y]\n    name: X\n    sensitivity: normal\n'),
    ['projects[0].tag must be a single value, not a list or mapping', 'projects[0]: tag is required']);
  assert.deepEqual(errorsOf(project('contexts: [A]\n')), ['context "A" is also a project tag or alias']);
  assert.deepEqual(errorsOf(project('people:\n  - name: Jo One\n  - name: jo one\n')), ['person "jo one" is listed twice']);
  assert.deepEqual(errorsOf(`programs:\n  north: []\n${project('')}`), ['programs.north must be a mapping with a name']);
  assert.deepEqual(errorsOf(`programs:\n  north: {name: [North]}\n${project('')}`), ['programs.north.name must be a single value, not a list or mapping']);
  assert.deepEqual(errorsOf(`programs:\n  north:\n${project('')}`), [], 'a program still to be filled in passes');
  assert.deepEqual(errorsOf('projects:\n  - tag: #kite\n    name: Kites\n    sensitivity: normal\n'), ['projects[0]: tag is required'],
    'unquoted, the # starts a YAML comment');

  const many = `projects:
  - tag: a
    name: A
    sensitivity: normal
    aliases: [x]
  - tag: b
    name: B
    aliases: [X]
  - name: Nameless tag
    sensitivity: restricted
people:
  - name: Jo One
    write_as: [Jo]
  - name: Jo Two
    write_as: [jo]
`;
  assert.deepEqual(errorsOf(many), [
    'b: sensitivity must be normal or restricted',
    'projects[2]: tag is required',
    'alias "X" of b is already a tag or alias of a',
    'write_as "jo" of Jo Two already means Jo One',
  ]);
});

test('tags: aliases and case variants map to the canonical tag; contexts stay; unknown tags are kept and flagged', () => {
  const r = parseRegistry(fixture);
  assert.equal(canonicalTag('#wr', r).tag, 'widget-report');
  assert.equal(canonicalTag('Gizmo', r).tag, 'widget-report');
  assert.equal(canonicalTag('# widget-REPORT ', r).tag, 'widget-report');
  assert.deepEqual(canonicalTag('Phone', r), { tag: 'phone', registered: true, context: true });
  assert.deepEqual(canonicalTag('##Mystery-Tag', r), { tag: 'Mystery-Tag', registered: false });
  assert.deepEqual(canonicalTags(['#wr', 'gizmo', 'SPROCKET-STUDY', 'Mystery', 'mystery', '#mystery', '', null], r), ['widget-report', 'Mystery'],
    'case variants of an unknown tag collapse to the first spelling');
  assert.deepEqual(unregisteredTags(['widget-report', 'phone', '#mystery', 'Mystery'], r), ['mystery'], 'returned as stored, once');
  assert.deepEqual(unregisteredTags(['mystery'], null), [], 'nothing is flagged without a registry');
  assert.deepEqual(canonicalTags(['#45Z'], null), ['45Z'], 'without a registry tags are kept as written');
});

test('people: full names and write_as resolve; a first name shared by two people is ambiguous', () => {
  const r = parseRegistry(fixture);
  assert.deepEqual(resolvePerson('Pat', r), { name: 'Pat Example', known: true, ambiguous: false });
  assert.deepEqual(resolvePerson('alex t', r), { name: 'Alex Two', known: true, ambiguous: false });
  assert.deepEqual(resolvePerson('Alex', r), { name: 'Alex', known: false, ambiguous: true });
  assert.deepEqual(resolvePerson('Jordan', r), { name: 'Jordan', known: false, ambiguous: false });
  assert.deepEqual(resolvePerson('', r), { name: null, known: false, ambiguous: false });
  assert.deepEqual(resolvePerson('Robin', r), { name: 'Robin', known: false, ambiguous: false }, 'a unique first name is not guessed');

  assert.equal(isFirstNameOf('alex', 'Alex Two', r), true);
  assert.equal(isFirstNameOf('Alex', 'Alex T', r), true, 'a stored write_as form means the same person');
  assert.equal(isFirstNameOf('Alex', 'alex two', r), true, 'so does a stored case variant');
  assert.equal(isFirstNameOf('Robin', 'Robin Fixture', r), true);
  assert.equal(isFirstNameOf('Alex', 'Pat Example', r), false);
  assert.equal(isFirstNameOf('Alex', 'Alex', r), false, 'only a registry person has a first name to match');
  assert.equal(isFirstNameOf('Alex', 'Alex Two', null), false);
  const oneWord = parseRegistry(fixture.replace('people:\n', 'people:\n  - name: Alex\n'));

  // A write_as form that is also someone else's first name is the registry's own choice: it wins, with a warning.
  const chosen = parseRegistry(fixture.replace('write_as: [Alex O]', 'write_as: [Alex O, Alex]'));
  assert.deepEqual(resolvePerson('Alex', chosen), { name: 'Alex One', known: true, ambiguous: false });
  assert.ok(chosen.warnings.includes('write_as "Alex" of Alex One is also the first name of Alex Two: it will always mean Alex One'));
  assert.equal(isFirstNameOf('Alex', 'Alex Two', oneWord), false, 'a one-word registry person is that person, not a first name');

  assert.equal(personAmbiguous({ person: 'Pat Example', assignee: 'Alex' }, r), true, 'either name');
  assert.equal(personAmbiguous({ person: 'Alex Two', assignee: 'Jordan' }, r), false);
  assert.equal(personAmbiguous({ person: 'Alex', assignee: null }, null), false, 'never without a registry');
});

test('a tag, alias or context written with "#" is stored without it; an unquoted one, lost to YAML, is reported', () => {
  const r = parseRegistry('projects:\n  - tag: "#kite"\n    name: Kites\n    sensitivity: normal\n    aliases: ["#ks", "# kt"]\ncontexts: ["#phone"]\n');
  assert.deepEqual([r.projects[0].tag, r.projects[0].aliases, r.contexts], ['kite', ['ks', 'kt'], ['phone']]);
  assert.deepEqual(canonicalTags(['#KS', 'kite', '#Phone'], r), ['kite', 'phone']);
  assert.match(promptBlock(r), /^- kite: Kites \(also written: ks, kt\)$/m);

  const lost = parseRegistry(`projects:
  - tag: kite
    name: Kites
    sensitivity: normal
    aliases:
      - #kites
      - ks
contexts:
  - "#phone"
  - Phone
`);
  assert.deepEqual([lost.projects[0].aliases, lost.contexts], [['ks'], ['phone']]);
  assert.deepEqual(lost.warnings, [
    'kite: aliases[0] is empty (ignored). An unquoted # starts a YAML comment: write "#x" in quotes, or leave the # out',
    'context "Phone" is listed twice',
  ]);
});

test("a key the registry doesn't read is a warning, so a typo can't silently drop aliases or names", () => {
  const r = parseRegistry(`version: 1
programs:
  north: {name: North, descripton: typo}
projects:
  - tag: kite
    name: Kites
    sensitivity: normal
    alias: [k]
    search: {mail: [kites]}
people:
  - name: Pat Example
    write-as: [Pat]
contex: [phone]
`);
  assert.deepEqual(r.warnings, [
    'unknown key "contex" (ignored)',
    'programs.north: unknown key "descripton" (ignored)',
    'kite: unknown key "alias" (ignored)',
    'kite: search: unknown key "mail" (ignored)',
    'Pat Example: unknown key "write-as" (ignored)',
  ]);
  assert.deepEqual(parseRegistry(fixture).warnings.filter((w) => w.includes('unknown key')), [], 'every key the format uses is known');

  // A misspelt required key fails, and the warning that explains why travels with the errors to `registry check`.
  const bad = path.join(dataDir, 'typo.yaml');
  fs.writeFileSync(bad, 'projects:\n  - tag: kite\n    nmae: Kites\n    sensitivity: normal\n');
  try { parseRegistry(fs.readFileSync(bad, 'utf8')); assert.fail('should not validate'); } catch (e) {
    assert.deepEqual([e.errors, e.warnings], [['kite: name is required'], ['kite: unknown key "nmae" (ignored)']]);
  }
  const run = spawnSync(process.execPath, [path.join(HERE, '..', 'scripts', 'check-registry.mjs'), bad], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /- kite: name is required\nwarnings[^\n]*\n {2}- kite: unknown key "nmae" \(ignored\)/);
  const cli = spawnSync(process.execPath, [path.join(HERE, '..', 'src', 'cli.js'), 'registry', 'check', bad],
    { encoding: 'utf8', env: { ...process.env, GLEANER_DATA_DIR: path.join(dataDir, 'cli-data') } });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /- kite: name is required\nwarnings[^\n]*\n {2}- kite: unknown key "nmae" \(ignored\)/);
});

test('version 1 in any spelling reads without a warning; another version warns', () => {
  for (const v of ['1', '"1"', '1.0', '01']) assert.deepEqual(parseRegistry(`version: ${v}\n${project('')}`).warnings, [], v);
  assert.deepEqual(parseRegistry(`version: 2\n${project('')}`).warnings, ['version 2: this Gleaner reads version 1']);
});

test('the prompt block lists every tag with its aliases, the contexts and the people, and is stable', () => {
  const r = parseRegistry(fixture);
  const block = promptBlock(r);
  assert.match(block, /^- widget-report: Widget emissions report \(also written: wr, gizmo, sprocket-study\)$/m);
  assert.match(block, /^- bridge-permit: Bridge permit bill \(also written: 404, 1\.10, 0707, bp\)$/m);
  assert.match(block, /^CONTEXT TAGS \(not projects; use as written\): phone, desk, later$/m);
  assert.match(block, /^- Pat Example, Pat → Pat Example$/m);
  assert.equal(promptBlock(parseRegistry(fixture)), block, 'same file, same bytes: the cached prefix holds');
  const sys = transcribeSystem(r);
  assert.ok(sys.includes(block));
  assert.match(sys, /fits more than one listed person stays exactly as written/);
  assert.doesNotMatch(sys, /person_ambiguous/, 'Gleaner works the flag out itself');
  assert.doesNotMatch(sys, /choose from this vocabulary/, 'the registry replaces the seed tag list');
  assert.match(transcribeSystem(null), /choose from this vocabulary/);
});

test('hot reload: a changed file is picked up; a file failing validation keeps the last good registry', () => {
  assert.equal(currentRegistry(), null, 'no file, no registry');
  assert.deepEqual(registryStatus(), { path: file, loaded: false, source: null, version: null, projects: 0, restricted: 0, warnings: [], errors: null });

  fs.writeFileSync(file, fixture);
  const first = currentRegistry();
  assert.equal(first.projects.length, 4);
  assert.equal(currentRegistry(), first, 'unchanged file: no re-parse');
  assert.equal(registryStatus().source, 'file');

  fs.writeFileSync(file, fixture.replace('aliases: [wr, gizmo, sprocket-study]', 'aliases: [wr, gizmo, sprocket-study, doohickey]'));
  const second = currentRegistry();
  assert.notEqual(second.version, first.version);
  assert.equal(canonicalTag('doohickey').tag, 'widget-report');

  // Well-formed YAML that fails a structural rule (a second "orchard"): the case the last-good rule exists for.
  fs.writeFileSync(file, fixture.replace('\npeople:', '  - tag: orchard\n    name: Duplicate\n    sensitivity: normal\n\npeople:'));
  assert.equal(currentRegistry().version, second.version, 'the invalid file is not used');
  assert.deepEqual(registryStatus().errors, ['duplicate tag "orchard"']);
  assert.equal(registryStatus().source, 'last-good');
  assert.equal(registryStatus().version, second.version);
});

test('the last good copy survives a fresh process: a new reader of a broken file falls back to it', () => {
  // Same directory, same saved copy, but a reader that never saw the good file (as after a restart, or in a
  // `docker exec … cli.js` process). Switching config to a path alias of the same file forgets the in-memory cache.
  const saved = path.join(dataDir, '.projects.yaml.last-good');
  assert.equal(fs.readFileSync(saved, 'utf8').includes('doohickey'), true, 'every valid version is saved');
  config.registry.path = `${dataDir}/./projects.yaml`; // the same file, by a different string
  const r = currentRegistry();
  assert.equal(r.version, parseRegistry(fs.readFileSync(saved, 'utf8')).version);
  assert.equal(registryStatus().source, 'last-good');
  assert.deepEqual(registryStatus().errors, ['duplicate tag "orchard"']);

  fs.rmSync(file);
  assert.equal(currentRegistry(), null, 'a deleted file means no registry, not the saved copy');
  config.registry.path = file;
});

test('a broken file falls back to the newest saved copy, even one another process saved', () => {
  const saved = path.join(dataDir, '.projects.yaml.last-good');
  fs.writeFileSync(file, fixture);
  const v1 = currentRegistry(); // the service loads v1
  const v2 = fixture.replace('aliases: [wr, gizmo, sprocket-study]', 'aliases: [wr, gizmo, sprocket-study, thingamajig]');
  fs.writeFileSync(saved, v2); // a `docker exec … cli.js` loaded and saved v2 before the service next looked
  fs.writeFileSync(file, v2.replace('\npeople:', '  - tag: orchard\n    name: Duplicate\n    sensitivity: normal\n\npeople:'));
  const r = currentRegistry();
  assert.notEqual(r.version, v1.version);
  assert.equal(r.version, parseRegistry(v2).version, 'the service and the CLI agree on v2');
  assert.equal(canonicalTag('thingamajig').tag, 'widget-report');
  assert.equal(registryStatus().source, 'last-good');
});

test('a change only the ctime shows, such as a chmod that makes the file readable, is picked up', (t) => {
  const at = new Date('2026-01-01T00:00:00Z');
  const broken = fixture.replace('sensitivity: normal', 'sensitivity: nirmal');
  assert.equal(broken.length, fixture.length);
  fs.writeFileSync(file, broken);
  fs.utimesSync(file, at, at);
  assert.deepEqual(registryStatus().errors, ['widget-report: sensitivity must be normal or restricted']);
  const before = fs.statSync(file).ctimeMs;
  // Rewrite in place (same inode and size) and put the mtime back, until the ctime has moved: inode times tick
  // coarsely, by up to a second or two on some filesystems.
  for (const end = Date.now() + 3000; fs.statSync(file).ctimeMs === before && Date.now() < end;) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    fs.writeFileSync(file, fixture);
    fs.utimesSync(file, at, at);
  }
  if (fs.statSync(file).ctimeMs === before) return t.skip('this filesystem never moved the ctime');
  assert.equal(registryStatus().source, 'file');
  assert.equal(registryStatus().errors, null);
});

// The saved copy on a full disk. fullDisk() makes writes to it (and its temporary file) land halfway, then fail.
const saved = path.join(dataDir, '.projects.yaml.last-good');
const write = fs.writeFileSync;
function fullDisk() {
  fs.writeFileSync = (p, data, ...rest) => {
    if (!String(p).startsWith(saved)) return write(p, data, ...rest);
    write(p, String(data).slice(0, String(data).length / 2), ...rest);
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  return () => { fs.writeFileSync = write; };
}
// A typo'd key: one error, and the warning that explains it. A different size, so the file's stamp always changes.
const broken = (text) => text.replace('sensitivity: normal', 'sensitivty: normal');
const withAlias = (alias) => fixture.replace('aliases: [wr, gizmo, sprocket-study]', `aliases: [wr, gizmo, sprocket-study, ${alias}]`);

test("a full disk never damages the saved copy, and a version this process couldn't save is kept until it can be", () => {
  fs.writeFileSync(file, fixture);
  assert.equal(registryStatus().source, 'file');
  assert.equal(fs.readFileSync(saved, 'utf8'), fixture);
  const v2 = withAlias('whatsit');
  const restore = fullDisk();
  try {
    fs.writeFileSync(file, v2);
    assert.equal(canonicalTag('whatsit').tag, 'widget-report', 'v2 in use; its save failed');
    assert.equal(fs.readFileSync(saved, 'utf8'), fixture, 'the saved copy is untouched, not cut short');
    assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')), [], 'no partial temporary file is left');
    fs.writeFileSync(file, broken(v2));
    const status = registryStatus();
    assert.equal(status.version, parseRegistry(v2).version, 'v2 kept, not the older saved copy');
    assert.deepEqual([status.errors, status.warnings],
      [['widget-report: sensitivity must be normal or restricted'],
        ['widget-report: unknown key "sensitivty" (ignored)', 'orchard: program "gamma" isn\'t listed under programs']],
      "the live file's errors, with the warning that explains them");
  } finally { restore(); }
  registryStatus();
  assert.equal(fs.readFileSync(saved, 'utf8'), fixture, 'not saved while the live file is broken: v2 is no longer the file');
  fs.writeFileSync(file, v2);
  assert.equal(registryStatus().source, 'file');
  assert.equal(fs.readFileSync(saved, 'utf8'), v2, 'saved once the disk has room');
});

test('a failed save is retried on every use while the file is unchanged', () => {
  const restore = fullDisk();
  try {
    fs.writeFileSync(file, fixture);
    assert.equal(registryStatus().source, 'file');
  } finally { restore(); }
  assert.notEqual(fs.readFileSync(saved, 'utf8'), fixture, 'not saved yet');
  registryStatus();
  assert.equal(fs.readFileSync(saved, 'utf8'), fixture, 'saved on the next use');
});

test('an unsaved version gives way to a newer copy another process saved', () => {
  const v2 = withAlias('gadget'), v3 = withAlias('doodad');
  const restore = fullDisk();
  try {
    fs.writeFileSync(file, v2);
    assert.equal(registryStatus().source, 'file'); // v2, unsaved
  } finally { restore(); }
  write(saved, v3); // meanwhile a `docker exec … cli.js` loaded v3 and saved it
  fs.writeFileSync(file, broken(v3)); // then the file broke before this process looked again
  assert.equal(registryStatus().version, parseRegistry(v3).version);
  assert.equal(canonicalTag('doodad').tag, 'widget-report');
});

test('the example registry in config/ stays valid and checks clean outside the app', () => {
  const examplePath = path.join(HERE, '..', 'config', 'projects.example.yaml');
  const r = parseRegistry(fs.readFileSync(examplePath, 'utf8'));
  assert.deepEqual(r.warnings, []);
  assert.equal(resolvePerson('Alex', r).ambiguous, true);
  const absent = path.join(dataDir, 'no-data-here');
  const out = JSON.parse(execFileSync(process.execPath, [path.join(HERE, '..', 'scripts', 'check-registry.mjs'), examplePath],
    { env: { PATH: process.env.PATH, GLEANER_DATA_DIR: absent } }).toString());
  assert.equal(out.projects, r.projects.length);
  assert.equal(fs.existsSync(absent), false, 'scripts/check-registry.mjs creates no data folder or database');
});
