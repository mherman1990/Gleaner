// A page whose every line is erased renders blank and is never read, and a page deleted on the tablet isn't pulled
// at all: either way its lines are gone, so an open item with no line left on any page is dropped (as "erased").
// Fixture notebook, mock LLM.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempEnv, rendererMissing, copyFixtures } from './helpers.js';

const skip = rendererMissing;
const fx = copyFixtures();
tempEnv('ingest-pages', { GLEANER_FIXTURE_DIR: fx });
const { db, setItemStatus } = await import('../src/db.js');
const { ingest } = await import('../src/pipeline/ingest.js');
const { dayFilePath, writeDayFiles } = await import('../src/output/markdown.js');
const { localDate } = await import('../src/config.js');
after(() => db.close());

const status = (text) => db.prepare('SELECT status, closed_by FROM items WHERE text=?').get(text);

// A copy of a fixture page with its ink taken out: a page whose lines were all erased.
function blankPage(from, to) {
  const r = spawnSync('python3', ['-I', '-c', `
import io, sys
from rmscene.scene_stream import read_blocks, write_blocks, SceneLineItemBlock, SceneGlyphItemBlock, RootTextBlock
with open(sys.argv[1], 'rb') as f: blocks = list(read_blocks(f))
out = io.BytesIO()
write_blocks(out, [b for b in blocks if not isinstance(b, (SceneLineItemBlock, SceneGlyphItemBlock, RootTextBlock))])
open(sys.argv[2], 'wb').write(out.getvalue())`, from, to], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('the items of a page erased blank, or deleted, are dropped; the rest stay; neither page is in the notes', { skip }, async () => {
  await ingest({ mode: 'sync' });
  for (const n of [1, 2, 3]) assert.equal(status(`Review notes from Daily p${n}`).status, 'open');
  const daily = path.join(fx, 'Daily');
  // Page 2's own item is already done, so erasing the page drops nothing; page 3's last read failed, so it's waiting
  // to be read again from its render when it's deleted.
  setItemStatus(db.prepare(`SELECT id FROM items WHERE text='Review notes from Daily p2'`).get().id, 'done', 'ui');
  // And page 2 is dated a day of its own, whose notes are only that page.
  const p2 = db.prepare(`SELECT p.id FROM pages p JOIN documents d ON d.id=p.doc_id WHERE d.name='Daily' AND p.page_index=1`).get().id;
  db.prepare(`UPDATE pages SET page_date='2026-10-01' WHERE id=?`).run(p2);
  writeDayFiles(['2026-10-01']);
  assert.ok(fs.existsSync(dayFilePath('2026-10-01')));
  const dailyPages = `SELECT p.* FROM pages p JOIN documents d ON d.id=p.doc_id WHERE d.name='Daily' ORDER BY p.page_index`;
  db.prepare(`UPDATE pages SET status='error', error='overloaded' WHERE id=?`).run(db.prepare(dailyPages).all()[2].id);
  blankPage(path.join(daily, '02.rm'), path.join(daily, '02.rm'));
  fs.rmSync(path.join(daily, '03.rm'));
  await ingest({ mode: 'sync' });
  assert.deepEqual(status('Review notes from Daily p1'), { status: 'open', closed_by: null });
  assert.deepEqual(status('Review notes from Daily p2'), { status: 'done', closed_by: 'ui' });
  assert.deepEqual(status('Review notes from Daily p3'), { status: 'dropped', closed_by: 'erased' }, 'deleted, and not read again');
  assert.equal(status('Send Tom the 45Z comment draft').status, 'open', 'still written on page 1');
  assert.deepEqual(db.prepare(dailyPages).all().map((p) => p.status), ['transcribed', 'blank', 'deleted']);
  const notes = fs.readFileSync(dayFilePath(localDate()), 'utf8');
  assert.match(notes, /Daily, page 1/);
  assert.doesNotMatch(notes, /Daily, page [23]/, 'the day\'s notes are written again without them');
  assert.equal(fs.existsSync(dayFilePath('2026-10-01')), false, 'page 2\'s own day has no notes left');
  await ingest({ mode: 'sync' });
  assert.equal(status('Review notes from Daily p3').status, 'dropped', 'and stays dropped');
});

test('a pull that lists no pages for a notebook that had some isn\'t taken as every page deleted', { skip }, async () => {
  const daily = path.join(fx, 'Daily');
  for (const f of fs.readdirSync(daily)) fs.rmSync(path.join(daily, f));
  await ingest({ mode: 'sync' });
  assert.equal(status('Review notes from Daily p1').status, 'open');
});
