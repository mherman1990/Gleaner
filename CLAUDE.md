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
- Offline test loop: `GLEANER_SOURCE=fixture GLEANER_LLM=mock GLEANER_DATA_DIR=./.testdata GLEANER_FIXTURE_DIR=./fixtures node src/cli.js ingest`.
  Fixture layout is `fixtures/<Notebook>/<NN>.rm`. Sample `.rm` files are in the ricklupton/rmc repo under `tests/rm/`.

## Guardrails
- **Do not enter credentials.** Matt registers rmapi himself (one-time code) and sets `ANTHROPIC_API_KEY` himself.
  Ask him to run those steps.
- While developing against the real account, set `GLEANER_TABLET_SHEET=false` and leave the Teams/ntfy env vars unset,
  so test runs don't write to his tablet or ping his phone. Turn them on only when he says so.
- Read-only toward the tablet, except the `_Today` sheet upload. Never delete or move tablet documents.
- Note text and page images are personal and work-sensitive. Don't log transcriptions beyond what's needed to debug,
  and don't add any new outbound destination without asking.

## v0.1 status: what's verified and what isn't
Verified offline, with fixtures and mock LLM:
- the render chain on real `.rm` v6 files,
- the batch and sync ingest paths, including idempotent re-runs,
- page-edit re-transcription without duplicates,
- cross-page carry-forward,
- the digest and Today PDF,
- the API, its token auth, and snooze,
- the reminder sweep, the weekly review, and the browser UI.

Not yet verified, in priority order:
1. **rmapi against the live account.** The JSON shape of `rmapi -ni -json find /Daily` is assumed (see the ls
   schema in the ddvk/rmapi README). Also confirm what `get --id` writes (`.rmdoc` or `.zip`) and its internal layout.
   Run `node src/cli.js doctor` first, and fix `listDocuments()`/`pull()` to match reality.
2. **Real model output.**
   - Check that forced-tool calls succeed on the configured model IDs.
   - Check that the extraction isn't noisy: tune `NOTATION` and the rules in `src/llm/prompts.js` against Matt's actual pages.
   - Check prompt caching hits in `/api/status` (`cache_read` > 0 on the second page of a run).
3. **Docker build on arm64.** Watch for the better-sqlite3 prebuild and the rmapi arm64 tarball layout.
4. **Umbrel install.** Use the app id and store prefix from his existing community app store (the same repo pattern as Spotter),
   and confirm `PROXY_AUTH_WHITELIST` lets `/api/*` through while the UI stays behind Umbrel login.

## Backlog (not v0.1)
- Read annotations on the `_Today` PDF by compositing strokes over the rendered PDF page, so ticks on the sheet close items.
- A remote MCP endpoint so remote (not computer-bound) Cowork tasks can query the ledger.
- Automated tests around `ledger.js` using fixture pages plus canned model results.
