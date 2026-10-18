import fs from 'node:fs';
import { config, localDate, isTaskList } from '../config.js';
import { db, now, sha256, startRun, endRun, openItems } from '../db.js';
import { source } from '../adapters/index.js';
import { renderPage } from './render.js';
import { applyPageResult, priorItemsForPage } from './ledger.js';
import { structuredParams, callStructured, submitBatch, collectBatch } from '../llm/client.js';
import { transcribeSystem, openLoopsBlock, RECORD_PAGE_SCHEMA, transcribeUser } from '../llm/prompts.js';
import { writeDayFiles, writeOpenLoops, mentionDates } from '../output/markdown.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[ingest]', ...a);

/** Step 1–2: pull changed documents, hash pages, render what changed. Returns # pages ready. */
async function pullAndRender() {
  const src = source();
  const docs = (await src.listDocuments()).filter((d) => !d.name.startsWith('_')); // _Today sheet etc. are outputs, not inputs
  let rendered = 0;
  for (const d of docs) {
    const known = d.id && db.prepare('SELECT version FROM documents WHERE id=?').get(d.id);
    if (known && d.version && known.version === d.version) continue; // unchanged since last pull
    const bundle = await src.pull(d);
    db.prepare(`INSERT INTO documents (id, name, folder, modified, version, last_pulled) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, folder=excluded.folder, modified=excluded.modified, version=excluded.version, last_pulled=excluded.last_pulled`)
      .run(bundle.id, bundle.name, bundle.folder, bundle.modified, bundle.version, now());
    if (bundle.fileType && bundle.fileType !== 'notebook') continue; // annotated PDFs/ebooks: out of scope for v1

    for (const p of bundle.pages) {
      const hash = sha256(fs.readFileSync(p.rmPath));
      const row = db.prepare('SELECT rm_hash, transcribed_hash, status FROM pages WHERE id=?').get(p.id);
      if (row && row.transcribed_hash === hash) continue;           // already transcribed this exact ink
      if (row && row.rm_hash === hash && row.status === 'queued') continue; // already in a batch
      const r = await renderPage(p);
      db.prepare(`INSERT INTO pages (id, doc_id, page_index, rm_hash, status, png_path, typed_text, updated_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET page_index=excluded.page_index, rm_hash=excluded.rm_hash, status=excluded.status,
          png_path=excluded.png_path, typed_text=excluded.typed_text, batch_id=NULL, updated_at=excluded.updated_at`)
        .run(p.id, bundle.id, p.index, hash, r.pngPath ? 'rendered' : 'blank', r.pngPath, r.typed_text, now());
      if (r.pngPath) rendered++;
    }
  }
  return { docs: docs.length, rendered };
}

function pageContext(pageRow) {
  const doc = db.prepare('SELECT name, modified FROM documents WHERE id=?').get(pageRow.doc_id);
  const dateHint = doc?.modified ? localDate(new Date(doc.modified)) : localDate();
  return { doc, dateHint };
}

function buildParams(pageRow, loopsBlock) {
  const { doc, dateHint } = pageContext(pageRow);
  return structuredParams({
    model: config.llm.transcribeModel,
    systemBlocks: [transcribeSystem(), loopsBlock],
    schema: RECORD_PAGE_SCHEMA,
    content: transcribeUser({
      docName: doc?.name || 'notebook', pageIndex: pageRow.page_index, dateHint,
      typedText: pageRow.typed_text, priorItems: priorItemsForPage(pageRow.id),
      imageB64: fs.readFileSync(pageRow.png_path).toString('base64'),
      taskList: isTaskList(doc?.name),
    }),
  });
}

/**
 * Have the next ingest read these pages again, e.g. after a prompt, model, or task-list change. Otherwise a page
 * is only re-read when its ink changes. scope: "all", a page date (YYYY-MM-DD), or a notebook name.
 * Clears the page and notebook fingerprints, so the next ingest re-pulls, re-renders, and re-transcribes them
 * (renders are not backed up, so they may be gone). Returns the number of pages queued.
 */
export function markForRetranscription(scope) {
  const where = scope === 'all' ? '1=1'
    : /^\d{4}-\d{2}-\d{2}$/.test(scope) ? 'p.page_date = @scope'
    : 'lower(trim(d.name)) = lower(trim(@scope))';
  const pages = db.prepare(`SELECT p.id, p.doc_id FROM pages p JOIN documents d ON d.id = p.doc_id
    WHERE ${where} AND p.status <> 'queued'`).all({ scope });
  const clearPage = db.prepare('UPDATE pages SET rm_hash=NULL, transcribed_hash=NULL WHERE id=?');
  const clearDoc = db.prepare('UPDATE documents SET version=NULL WHERE id=?');
  db.transaction(() => {
    for (const p of pages) clearPage.run(p.id);
    for (const id of new Set(pages.map((p) => p.doc_id))) clearDoc.run(id);
  })();
  return pages.length;
}

async function applyAll(rows, results) {
  const dates = new Set();
  const itemIds = new Set();
  const tally = { created: 0, carried: 0, closed: 0, failed: 0 };
  // Sequential on purpose: dedupe must see items created by earlier pages in the same run.
  for (const row of rows.sort((a, b) => a.doc_id.localeCompare(b.doc_id) || a.page_index - b.page_index)) {
    const r = results.get(row.id);
    if (!r?.ok) {
      db.prepare(`UPDATE pages SET status='error', error=?, batch_id=NULL WHERE id=?`).run(r?.error || 'no result', row.id);
      tally.failed++; continue;
    }
    const s = await applyPageResult(row, r.input, pageContext(row).dateHint);
    dates.add(s.pageDate); if (s.prevDate) dates.add(s.prevDate);
    s.itemIds.forEach((id) => itemIds.add(id));
    tally.created += s.created; tally.carried += s.carried; tally.closed += s.closed;
  }
  // Earlier days whose items were just carried, closed, or dropped show stale item lines until rewritten.
  mentionDates([...itemIds]).forEach((d) => dates.add(d));
  return { dates, tally };
}

// Batch custom_id must match ^[a-zA-Z0-9_-]{1,64}$ — tablet page UUIDs already do.
const cid = (pageId) => pageId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
const byPageId = (rows, res) => new Map(rows.map((r) => [r.id, res.get(cid(r.id))]));

/** Collect any finished batches from earlier runs (e.g. the process restarted mid-poll). */
async function collectPending() {
  const pending = db.prepare(`SELECT * FROM batches WHERE status='in_progress'`).all();
  const dates = new Set();
  for (const b of pending) {
    const res = await collectBatch(b.id, 'transcribe');
    if (!res) continue;
    const rows = db.prepare(`SELECT * FROM pages WHERE batch_id=?`).all(b.id);
    const out = await applyAll(rows, byPageId(rows, res));
    out.dates.forEach((d) => dates.add(d));
    db.prepare(`UPDATE batches SET status='ended', ended_at=? WHERE id=?`).run(now(), b.id);
    log(`batch ${b.id}:`, out.tally);
  }
  return dates;
}

/**
 * mode "batch": nightly; submits a Batch API job and waits (bounded), falling back to sync for stragglers.
 * mode "sync":  morning top-up / on-demand; transcribes immediately.
 */
export async function ingest({ mode = 'batch' } = {}) {
  const runId = startRun(`ingest:${mode}`);
  try {
    const dates = await collectPending();
    const pulled = await pullAndRender();
    const rows = db.prepare(`SELECT * FROM pages WHERE status IN ('rendered','error') AND png_path IS NOT NULL`).all();
    const loops = openLoopsBlock(openItems());
    let tally = { created: 0, carried: 0, closed: 0, failed: 0 };

    if (rows.length && mode === 'batch' && config.llm.useBatch) {
      const batchId = await submitBatch(rows.map((r) => ({ custom_id: cid(r.id), params: buildParams(r, loops) })));
      db.prepare(`INSERT INTO batches (id, kind, status, created_at) VALUES (?,?,?,?)`).run(batchId, 'transcribe', 'in_progress', now());
      const upd = db.prepare(`UPDATE pages SET status='queued', batch_id=? WHERE id=?`);
      rows.forEach((r) => upd.run(batchId, r.id));
      log(`submitted batch ${batchId} with ${rows.length} pages`);

      const deadline = Date.now() + config.llm.batchMaxWaitMinutes * 60000;
      let res = null;
      while (Date.now() < deadline && !(res = await collectBatch(batchId, 'transcribe'))) {
        await sleep(config.llm.batchPollSeconds * 1000);
      }
      if (res) {
        const out = await applyAll(rows, byPageId(rows, res));
        out.dates.forEach((d) => dates.add(d)); tally = out.tally;
        db.prepare(`UPDATE batches SET status='ended', ended_at=? WHERE id=?`).run(now(), batchId);
      } else {
        log(`batch ${batchId} still running after ${config.llm.batchMaxWaitMinutes} min; next run collects it`);
      }
    } else if (rows.length) {
      const results = new Map();
      for (const r of rows) {
        try { results.set(r.id, { ok: true, input: await callStructured(buildParams(r, loops), 'transcribe') }); }
        catch (e) { results.set(r.id, { ok: false, error: e.message }); }
      }
      const out = await applyAll(rows, results);
      out.dates.forEach((d) => dates.add(d)); tally = out.tally;
    }

    writeDayFiles([...dates]);
    writeOpenLoops();
    const detail = { ...pulled, pages: rows.length, ...tally, dates: [...dates] };
    log(detail);
    endRun(runId, true, detail);
    return detail;
  } catch (e) {
    endRun(runId, false, e.stack || e.message);
    throw e;
  }
}
