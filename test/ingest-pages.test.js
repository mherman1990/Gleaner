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
const { db } = await import('../src/db.js');
const { ingest } = await import('../src/pipeline/ingest.js');
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

test('the items of a page erased blank, or deleted, are dropped; the rest stay', { skip }, async () => {
  await ingest({ mode: 'sync' });
  for (const n of [1, 2, 3]) assert.equal(status(`Review notes from Daily p${n}`).status, 'open');
  const daily = path.join(fx, 'Daily');
  blankPage(path.join(daily, '02.rm'), path.join(daily, '02.rm'));
  fs.rmSync(path.join(daily, '03.rm'));
  await ingest({ mode: 'sync' });
  assert.deepEqual(status('Review notes from Daily p1'), { status: 'open', closed_by: null });
  assert.deepEqual(status('Review notes from Daily p2'), { status: 'dropped', closed_by: 'erased' }, 'erased blank');
  assert.deepEqual(status('Review notes from Daily p3'), { status: 'dropped', closed_by: 'erased' }, 'deleted');
  assert.equal(status('Send Tom the 45Z comment draft').status, 'open', 'still written on page 1');
});
