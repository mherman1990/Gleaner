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
  - A line no longer on a page is marked gone there (`item_mentions.gone_at`; the row stays for the sensitivity
    filter), and an open item (or one whose snooze is over) with no line left on any page is dropped as "erased". A
    page that renders blank, or is deleted on the tablet (status `deleted`, never read again), counts as every line
    gone (`pageEmptied`). Items whose line left a page in the last 6 hours (`MOVED_WITHIN_HOURS`: the same sync or the
    next) are dedupe candidates: a line cut from one page and pasted on another is the same item, moved (an erased drop
    reopens). Striking a line through cancels it, as the notation says; it isn't a move. The model returns a struck
    line as a "dropped" item, and one that matches no item is nothing; a struck line older than the item's line on
    another page (`item_mentions.linked_at`) ends only that copy. The rules for which item a line is are listed at
    `applyPageResult`, and the dedupe's labels (OPEN, ERASED, CLOSED, OTHER) at `matchExisting`. A line written again
    on its page after its item was closed and its line left it, long after an erased drop, or in place of its ticked
    or struck line (`item_mentions.mark`: how the line was last read) is a new item, linked to the old one in
    `item_sources`. A tick, strike or close by number already read isn't applied again, so a person's reopen sticks.
    A close by number, a struck line, or a person dropping it, makes an erased item's drop final. A due date changed
    on the page, or a time on a dated page, resets the nudges, as a hand edit does. Accepted trade-offs: a line a
    read missed that comes back over 6 hours later, or after its item was closed meanwhile, is a new item; a moved
    line whose new page is read before its old one can't match a closed or snoozed item's unticked line; a tick the
    model misses on a re-read makes the task a new open item.
  - Items have a `source`: `handwriting`, or what an API client named when it created one with `POST /api/items`
    (`src/adapters/api-inbox.js`, an item-source adapter; requests are rows in `inbox`, retried at the next ingest).
    A created item goes through the same dedupe as a new line (`upsertCandidate`), against open items only, as they are
    when the request has its turn: a match fills the open item's empty fields and adds tags, never its text, a field in
    `edited`, or its source. Tags a client gave are kept in `items.api_tags`, which `refreshItem` adds to the page's.
    One `source` + `source_ref` is one item: the item they created, or the one they were merged into (from `inbox`),
    whatever its status. Only `handwriting` items are dropped when their line is erased. Page applies and creates take
    turns (`withLedger`, in-process); a failed request is retried at each ingest for a week.
  - In task-list notebooks (`notebooks.taskLists`, default `["To do"]`), every written line is an item. Elsewhere
    only the notation or an explicit commitment makes one. The rule is in the cached system prompt, and the
    per-page flag is in the user turn.
  - Items carry `due` + `due_time` (HH:MM local) and `assignee` (null = Matt). The model reads them from the page
    (`2pm`, `@Jen`). A hand edit (`editItem()` in `src/db.js`, used by the UI, API and CLI) records the field in
    `items.edited`, and `refreshItem` never overwrites an edited field. Due date and time count as one field.
  - Tags and people go through the project registry (`src/registry.js` loads `/data/projects.yaml`;
    `src/registry-schema.js` holds the format rules and lookups with no I/O; example in
    `config/projects.example.yaml`). It's read with YAML's failsafe schema, so every value is the text written.
    Aliases are stored as canonical tags (a leading `#` in the file is dropped); unknown tags are kept as written.
    A shared first name is stored as written, and a re-read never replaces a stored registry person with their own
    first name. `unregistered_tags` and `person_ambiguous` are not stored: the API works them out from the stored
    tags and names against the current registry, so they never go stale. The registry is in the cached
    transcription prompt and reloads when the file changes (stat incl. ctime). Every valid version is saved as
    `.projects.yaml.last-good`, which a broken file falls back to in any process; unknown keys only warn.
    **Never commit Matt's `projects.yaml`:** this repo is public and the file names colleagues and restricted work.
- **API clients, sensitivity, audit trail** (v0.2 step 2):
  - `src/auth.js`: per-client tokens in `/data/tokens.json`, sha256 hashes only (mode 0600, re-read when it changes),
    each with scopes (`read`, `write`, `create`, `ingest`, `digest`) and a sensitivity (`all` or `normal`). CLI
    `token add|revoke|list`. `GLEANER_API_TOKEN` is client `legacy` through v0.2.x; `/ui-api` is client `ui`.
  - `src/sensitivity.js`: every route that returns content asks `visibility()`. At `normal`, an item whose tags are
    or were restricted (aliases count; history from the events), or mentioned on a page whose tags are or were
    restricted (`page_tags`), or written from such an item (`item_sources`, followed to the end), is left out of
    everything, and so is any page that mentions, closes or snoozes one (`page_closes`). These tables (migration 003)
    are only added to, so a re-read never unhides anything; rows another process wrote after the judgement are
    hidden; with no registry it's a 503. Each GET route reads in one transaction with its `visibility()` call, and
    `POST /items/:code` checks and writes under one write lock.
    `applyPageResult` writes a page and its items in one transaction, after the dedupe call. The prompt lists only a
    page's own lines; the items it closed or snoozed (`closedOnPage`) are kept out of it, so the model can't read "✓14"
    back as item 14's line. A ticked line read again without its id is matched in code (same words as a done item of
    the page) or by the dedupe (done items are offered, labelled CLOSED, to ticked lines only), and a match to an item
    the page closed changes nothing.
    `test/sensitivity.test.js` sweeps every GET route; a new route needs a probe there.
  - `gleaner-mcp/server.mjs` (v0.2 step 7): the local MCP server the Claude app runs on Matt's computers (packed as
    a `.mcpb` extension by `npm run pack:mcpb`). One file, no dependencies, stdio JSON-RPC by hand; each tool calls
    the `/api` with that computer's token. It isn't in the Docker image. A new API action gets its tool there, and in
    `manifest.json`'s tool list (`test/mcp.test.js` checks both).
  - Projects and health (v0.2 step 4), no LLM. `src/projects.js`: `/api/projects` (registry + open, waiting, overdue,
    carried_max, last_activity; `unregistered` tags) and `/api/projects/:tag?days=30`. A page belongs to a project by
    its tags; an item by its own project tags, or with none, by the tags of the pages it's on. `src/health.js`:
    `/api/health`, and `healthCheck` every 15 minutes 6:07–21:52 (`healthCheckJob` guards 6:00–22:00; the sign-in isn't
    checked while `busy()`, as two rmapi processes can both rewrite its config) that alerts through
    `notify()` on batch_late, source_auth (adapter `authCheck()`), runs_failed, memory, disk and spend (priced from
    `config.prices`). State is the `alerts` table (migration 006): at most once per condition per
    `health.alertEveryHours`, and only a send a channel accepted counts. At normal, health gives no detail text.
  - Every item write goes through `changeItem()` / `recordEvent()` in `src/db.js`, which write the `events` rows
    with the client; `editItem()` and `setItemStatus()` require one. `src/events.js` reads them (`/api/events`, the
    digest's "Mayer closed 3" line). A new mutating route needs an events test (`test/events.test.js` checks).
- **Schema changes are numbered migrations** in `src/migrations/` (runner in `index.js`, recorded in
  `schema_migrations`). They only add things; never edit one that has shipped. `001-baseline-v0.1.4` is the schema
  from before the runner. `test/migrate.test.js` runs every migration against `test/fixtures/v0.1.4.sql`.
- **Markdown in `notes/` is generated** from SQLite and is idempotent. Never treat it as input.
- **Model tiering:** Sonnet transcribes, Haiku dedupes, Sonnet writes the daily plan, Opus writes the weekly review.
  Structured output uses `output_config.format` JSON schemas (`structuredParams` / `structuredOutput` in
  `src/llm/client.js`). Never force a tool: `tool_choice` `tool`/`any` returns a 400 on Sonnet 5.5 and Opus 5.5.
  The schemas must stay inside the structured-output JSON Schema subset; `test/llm.test.js` lints them.
  Thinking is always on for the 5.5 models and counts toward `max_tokens`, so keep caps generous (16K).
  Static system prompts and the per-run open-loop block carry `cache_control`.
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
  without a token (`/data/tokens.json`, or the legacy `GLEANER_API_TOKEN`).
- **v0.2 work follows `docs/IMPLEMENTATION_PLAN.md`** (one PR per spec step, each with its acceptance test). Steps
  that need Matt's hands (tokens, keys, Telegram/Signal, OpenClaw, Tailscale, Cowork) go in `docs/RUNBOOK_v0.2.md`.
- Reviews: one review pass per PR, fix what it confirms, then hand the PR to Matt. No repeated verify rounds: his real
  pages are the better test.
- Tests: `npm test` (node:test, mock LLM, temp data dirs). Tests that need the real request shape point the SDK at
  `test/fakes/anthropic.js` (`ANTHROPIC_BASE_URL`), which also reports prompt-cache reads. Fixture content is invented. The end-to-end tests need `rmc` and `cairosvg` on PATH
  and skip without them. Run it before every push; CI runs it plus an image build on each PR.
- Offline test loop: `GLEANER_SOURCE=fixture GLEANER_LLM=mock GLEANER_DATA_DIR=./.testdata GLEANER_FIXTURE_DIR=./fixtures node src/cli.js ingest`.
  Fixture layout is `fixtures/<Notebook>/<NN>.rm`; the committed pages come from ricklupton/rmc `tests/rm/` (MIT).

## Guardrails
- **Do not enter credentials.** Matt registers rmapi himself (one-time code) and sets `ANTHROPIC_API_KEY` himself.
  Ask him to run those steps.
- While developing against the real account, set `GLEANER_TABLET_SHEET=false` and leave the Teams/ntfy env vars unset,
  so test runs don't write to his tablet or ping his phone. Turn them on only when he says so.
- Read-only toward the tablet, except the `_Today` sheet upload. Never delete or move tablet documents.
- Privacy: Gleaner runs on Matt's own Pi, the notes are his, and Telegram goes only to him. Keep the restricted-project
  filter (`src/sensitivity.js`) as built, and give a new read route its `visibility()` call and probe, but don't add
  more privacy machinery (Telegram included) unless he asks. Ask before adding a new outside service.

## v0.1 status: what's verified and what isn't
Verified offline with fixtures and the mock LLM, and covered by `npm test`:
- the render chain on real `.rm` v6 files, including typed-text-only pages,
- the batch and sync ingest paths, including idempotent re-runs,
- page-edit re-transcription without duplicates or renumbering,
- cross-page carry-forward, erase-to-drop, and number closes/snoozes,
- markdown kept in sync when items change later (closes, carries, API/CLI status changes, a page's date moving),
- the digest and Today PDF, the reminder sweep (a nudge counts only once a channel accepted it), and the weekly review,
- every `config.schedule` entry having a job in `src/scheduler.js` and a valid cron expression,
- the API, its token auth, date validation, and snooze,
- hand edits (text, due date and time, assignee) surviving a re-read, reopen, Undo, and timed reminders; the browser
  UI's Edit / Undo / Reopen flows were driven in Chromium against fixture data (not in `npm test`),
- one ingest at a time across the scheduler and the API (`src/jobs.js`).

Verified live on Matt's Pi (v0.1.0, 2026-10-17):
- rmapi registration, `doctor`, `find -json` (a real notebook's `version` is `0`, so the `version:modifiedClient` key is
  required), and `get` + unzip + render on a real notebook.
- Umbrel's proxy lets `/api/*` through without its login: `/api/status` gave 401 without the token and 200 with it.
- The first live transcription failed: v0.1.0 forced `tool_choice`, which Sonnet 5.5 rejects. v0.1.1 uses structured outputs,
  and a live sync transcription with Sonnet 5.5 succeeded. On v0.1.2, `retranscribe "To do"` turned that page's two lines into items.
- The Release workflow's store sync: v0.1.1 (after a re-run, since `STORE_REPO` was created mid-run) and v0.1.2 (automatic).
- v0.1.4 (2026-10-18): the startup migration on the live database, `GLEANER_TABLET_SHEET=false`, and a live sync read
  of 2 changed pages that created 2 items. That read took 5½ minutes end to end, so *Ingest now* must wait for the
  run rather than refresh after a fixed delay. The log now times each page's render and transcription.
- v0.2.1 (2026-10-20): the `gleaner-1.0.0.mcpb` extension installed in the Claude desktop app on both of Matt's computers
  (tokens `claude-home`, `claude-work`), and the Gleaner Ledger artifact (`host:` server) lists items, ticks them off
  (seen in Gleaner's UI) and adds a task through `POST /api/items`. Ticking goes through `POST /api/items/:code`, so
  Umbrel's `PROXY_AUTH_WHITELIST` lets nested `/api/*` paths through.

Verified against ddvk/rmapi v0.0.35's source:
- `rmapi -ni -json find /Daily` prints a JSON array of `{id, name, type, version, modifiedClient, parent, tags, …}`.
  WARNING log lines also go to **stdout**, so `parseFindJson()` reads from where the array starts.
- `version` is the doc's `.metadata` version, which current firmware doesn't bump, so change detection keys on
  `version:modifiedClient`.
- `get --id <id>` writes `<name>.rmdoc` into the cwd: a zip of `<docId>.content`, `<docId>.metadata`, and `<docId>/<pageId>.rm`.
- Release assets are `rmapi-linux-{amd64,arm64}.tar.gz`, with the `rmapi` binary at the archive root.

Verified in Docker: the image builds for amd64 and for arm64 (under QEMU). On both, rmapi, rmc, cairosvg, and the
better-sqlite3 native module load, and the arm64 container runs fixture ingest and digest end to end.

Not yet verified, in priority order:
1. **Real model output.**
   - Transcription (Sonnet) works live. Check the other calls the same way: dedupe (Haiku, the first page with an item
     already open), the morning digest, the nightly Batch API run, and the weekly review (Opus). A page that fails keeps
     its reason in `pages.error`.
   - Check that the extraction isn't noisy: tune `NOTATION` and the rules in `src/llm/prompts.js` against Matt's actual pages.
     Pages are only re-read when their ink changes, so after a tuning change run `cli.js retranscribe <scope>`.
     The first live page (a two-line "To do" list) produced no items under the strict rules, which led to taskLists.
   - Check prompt caching hits in `/api/status` (`cache_read` > 0 on the second page of a run). The 5.5 models cache
     prefixes from 512 tokens, and the transcription system prompt is about 1,200, so it should cache. The dedupe,
     digest, and weekly prompts are far shorter and don't; a prefix under the minimum fails silently, not with an error.
2. **rmapi over time.** Confirm that a page edited on the tablet is picked up on the next run.
3. **On the Pi itself.** Render and transcription time per page are in the log (`docker logs herman-gleaner_web_1 | grep
   '\[ingest\]'`). The first live read averaged about 2½ minutes per page; find out which step dominates. Also check
   memory use during a batch.
4. **Due times and assignees from real pages.** The model reading `2pm` / `@Name` from Matt's handwriting.

## Backlog (not v0.1)
- **Project wiki** (`docs/WIKI_PLAN.md`, design agreed 2026-10-20, built after the v0.2 steps): one cited page per
  active/watch project, compiled nightly from tagged pages, Haiku-filed untagged pages, and notes Matt gives Claude.
- Read annotations on the `_Today` PDF by compositing strokes over the rendered PDF page, so ticks on the sheet close items.
- A remote MCP endpoint so remote (not computer-bound) Cowork tasks can query the ledger.
- The job lock is in-process. A `docker exec … cli.js ingest` running alongside the service isn't covered by it.
