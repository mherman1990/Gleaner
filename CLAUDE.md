# Gleaner — context for Claude Code

Self-hosted service (Umbrel, Raspberry Pi 5 / arm64) that turns Matt's handwritten reMarkable notes into dated
markdown, an open-loop task ledger, a morning Today sheet pushed back to the tablet, and due/overdue nudges.
Read README.md for setup and docs/HANDWRITING.md for the notation the extractor relies on.

## Architecture (keep it this way)
- **Adapters at the edges.** Every source adapter has the same contract: `listDocuments()`, `pull(doc)` → DocBundle,
  `upload(pdf, folder)`, `doctor()`. The contract lives in `src/adapters/bundle.js`, and the adapters are
  `src/adapters/{rmapi,ssh,fixture}.js`. Delivery adapters live in `src/notify/`. New integrations are new adapters, not
  branches in the pipeline.
- **Pipeline:** `src/pipeline/ingest.js` pulls changed docs, fingerprints each page's `.rm` file (sha256), and renders
  changed pages via `py/render_page.py` (rmc → SVG → cairosvg PNG). It then transcribes, through the Batch API at night and
  synchronously otherwise. `src/pipeline/ledger.js` applies the results.
- **Ledger semantics:**
  - Same-page items update in place via `existing_item_id`.
  - Number closes (`✓14`, `x14`, `14 → Fri`) act on earlier items.
  - New items are deduped against open loops by Haiku; a match bumps `carry_days`.
  - An item that came from only one page and was erased from it is dropped.
- **Markdown in `notes/` is generated** from SQLite and is idempotent. Never treat it as input.
- **Model tiering:** Sonnet transcribes, Haiku dedupes, Sonnet writes the daily plan, Opus writes the weekly review.
  Structured output uses forced tool calls. Static system prompts and the per-run open-loop block carry `cache_control`.
  Keep both caching and batching.

## Conventions
- Node 22, ESM, no TypeScript, no build step. Keep dependencies minimal and pin them exactly. Only pick versions
  published at least two weeks ago.
- Config is defaults ← `/data/config.json` ← env, with secrets in `/data/gleaner.env`. Never commit secrets, `data/`, or `.testdata/`.
- Dates are local (`localDate()` in `src/config.js`, America/Chicago), never UTC slices.
- **Umbrel packaging:** Gleaner is `herman-gleaner` in the Herman Apps store (`mherman1990/spotter-umbrel-store`, shared
  with Spotter). Its listing lives here in `umbrel-store/herman-gleaner/`; the Release workflow (tag `vX.Y.Z` matching
  `package.json`) builds the image, syncs only that folder into the store, and pins the digest. The store's `README.md`
  and `umbrel-app-store.yml` belong to the spotter repo; never sync them from here. Spotter's release runs
  `check-store.mjs` over every app folder, so `herman-gleaner/` must keep passing it (`test/store.test.js` enforces this;
  `scripts/check-store.mjs` is a verbatim copy of Spotter's). `/api/*` skips Umbrel login, so it stays disabled
  without `GLEANER_API_TOKEN`.
- Tests: `npm test` (node:test, mock LLM, temp data dirs). The end-to-end tests need `rmc` and `cairosvg` on PATH
  and skip without them. Run it before every push; CI runs it plus an image build on each PR.
- Offline test loop: `GLEANER_SOURCE=fixture GLEANER_LLM=mock GLEANER_DATA_DIR=./.testdata GLEANER_FIXTURE_DIR=./fixtures node src/cli.js ingest`.
  Fixture layout is `fixtures/<Notebook>/<NN>.rm`; the committed pages come from ricklupton/rmc `tests/rm/` (MIT).

## Guardrails
- **Do not enter credentials.** Matt registers rmapi himself (one-time code) and sets `ANTHROPIC_API_KEY` himself.
  Ask him to run those steps.
- While developing against the real account, set `GLEANER_TABLET_SHEET=false` and leave the Teams/ntfy env vars unset,
  so test runs don't write to his tablet or ping his phone. Turn them on only when he says so.
- Read-only toward the tablet, except the `_Today` sheet upload. Never delete or move tablet documents.
- Note text and page images are personal and work-sensitive. Don't log transcriptions beyond what's needed to debug,
  and don't add any new outbound destination without asking.

## v0.1 status: what's verified and what isn't
Verified offline with fixtures and the mock LLM, and covered by `npm test`:
- the render chain on real `.rm` v6 files, including typed-text-only pages,
- the batch and sync ingest paths, including idempotent re-runs,
- page-edit re-transcription without duplicates or renumbering,
- cross-page carry-forward, erase-to-drop, and number closes/snoozes,
- markdown kept in sync when items change later (closes, carries, API/CLI status changes, a page's date moving),
- the digest and Today PDF, the reminder sweep, and the weekly review,
- the API, its token auth, date validation, and snooze,
- one ingest at a time across the scheduler and the API (`src/jobs.js`).

Verified against ddvk/rmapi v0.0.35's source (not yet against the live account):
- `rmapi -ni -json find /Daily` prints a JSON array of `{id, name, type, version, modifiedClient, parent, tags, …}`.
  WARNING log lines also go to **stdout**, so `parseFindJson()` reads from where the array starts.
- `version` is the doc's `.metadata` version, which current firmware doesn't bump, so change detection keys on
  `version:modifiedClient`.
- `get --id <id>` writes `<name>.rmdoc` into the cwd: a zip of `<docId>.content`, `<docId>.metadata`, and `<docId>/<pageId>.rm`.
- Release assets are `rmapi-linux-{amd64,arm64}.tar.gz`, with the `rmapi` binary at the archive root.

Verified in Docker: the image builds for amd64 and for arm64 (under QEMU). On both, rmapi, rmc, cairosvg, and the
better-sqlite3 native module load, and the arm64 container runs fixture ingest and digest end to end.

Not yet verified, in priority order:
1. **rmapi against the live account.** Run `node src/cli.js doctor`. Expect `documents` > 0 and a JSON `findSample`.
   Then run one ingest and confirm that a page edited on the tablet is picked up on the next run.
2. **Real model output.**
   - Check that forced-tool calls succeed on the configured model IDs.
   - Check that the extraction isn't noisy: tune `NOTATION` and the rules in `src/llm/prompts.js` against Matt's actual pages.
   - Check prompt caching hits in `/api/status` (`cache_read` > 0 on the second page of a run).
3. **On the Pi itself.** Check render time per page and memory use during a batch.
4. **Umbrel install.** The listing passes Spotter's store checks, and `v0.1.0` is in the store, but nobody has installed it
   on the Pi yet. Confirm that `PROXY_AUTH_WHITELIST` lets nested paths like `/api/items/14` through while the UI stays
   behind Umbrel login. Other store apps (e.g. Bazarr) rely on `"/api/*"` for nested APIs, so this should hold.
   The first automated store sync (the next release after `STORE_REPO` / `STORE_REPO_TOKEN` are set) is also untested.

## Backlog (not v0.1)
- Read annotations on the `_Today` PDF by compositing strokes over the rendered PDF page, so ticks on the sheet close items.
- A remote MCP endpoint so remote (not computer-bound) Cowork tasks can query the ledger.
- The job lock is in-process. A `docker exec … cli.js ingest` running alongside the service isn't covered by it.
