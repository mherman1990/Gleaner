// One page that can't be applied (here: the Haiku dedupe call keeps failing for it) doesn't stop the run: that page
// is marked as an error with the reason, the other pages are applied, and the next run reads it again. Real SDK
// against the fake API, fixture notebook. All content is invented.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempEnv, rendererMissing, FIXTURES } from './helpers.js';
import { fakeAnthropic } from './fakes/anthropic.js';

const skip = rendererMissing;
const userText = (params) => {
  const c = params.messages[0].content;
  return typeof c === 'string' ? c : c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
};
let failPage = 2; // the page whose dedupe call fails; null once the API is back
const fake = await fakeAnthropic((params, purpose) => {
  if (purpose === 'transcribe') {
    const n = Number(userText(params).match(/page (\d+)/)[1]);
    return { page_date: '2026-10-18', summary: `Invented page ${n}`, tags: [], transcription_md: `- ☐ Follow up on page ${n}`,
      legibility: 'high', uncertain_spans: [], closes: [],
      items: [{ existing_item_id: null, text: `Follow up on page ${n}`, kind: 'action', person: null, assignee: null,
        due: null, due_time: null, priority: false, status: 'open', tags: [] }] };
  }
  if (purpose === 'dedupe') {
    if (failPage && userText(params).includes(`NEW n0: Follow up on page ${failPage}`)) throw new Error('overloaded');
    return { matches: [] };
  }
  throw new Error(`unexpected ${purpose} call`);
});
const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'gleaner-fx-'));
fs.cpSync(path.join(FIXTURES, 'Daily'), path.join(fx, 'Daily'), { recursive: true });
tempEnv('ingest-errors', { GLEANER_LLM: 'live', ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: fake.url, GLEANER_FIXTURE_DIR: fx });

const { db } = await import('../src/db.js');
const { ingest } = await import('../src/pipeline/ingest.js');
after(() => { db.close(); fake.close(); });

const pages = () => db.prepare('SELECT page_index, status, error FROM pages ORDER BY page_index').all();
const items = () => db.prepare('SELECT text FROM items ORDER BY code').all().map((i) => i.text);

test('a page that fails to apply is marked with why, the rest of the run is applied, and the next run reads it again', { skip }, async () => {
  const first = await ingest({ mode: 'sync' });
  assert.equal(first.failed, 1);
  const [p1, p2, p3] = pages();
  assert.deepEqual([p1.status, p3.status], ['transcribed', 'transcribed']);
  assert.equal(p2.status, 'error');
  assert.match(p2.error, /^applying: .*overloaded/);
  assert.deepEqual(items(), ['Follow up on page 1', 'Follow up on page 3'], 'a page after the failed one was applied');
  assert.equal(db.prepare(`SELECT ok FROM runs WHERE kind='ingest:sync' ORDER BY id DESC`).get().ok, 1);

  failPage = null;
  const second = await ingest({ mode: 'sync' });
  assert.deepEqual([second.pages, second.failed], [1, 0], 'only the failed page is read again');
  assert.deepEqual(pages().map((p) => [p.status, p.error]), [['transcribed', null], ['transcribed', null], ['transcribed', null]]);
  assert.deepEqual(items(), ['Follow up on page 1', 'Follow up on page 3', 'Follow up on page 2']);
});
