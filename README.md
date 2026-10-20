# Gleaner

Handwritten reMarkable notes become dated markdown, an open-loop ledger, a morning Today sheet pushed back to
the tablet, and due/overdue nudges. Gleaner is self-hosted on Umbrel. Only the configured tablet folder (`/Daily`) is read.

```
tablet ─(Connect cloud)→ rmapi ─→ changed pages only ─→ rmc → PNG ─→ Claude (Sonnet, Batch API overnight)
                                                                         │
     notes/YYYY/YYYY-MM-DD.md  ←── SQLite ledger (items, numbers, carry-days, closes) ──→ /api, UI
                                        │
   6:30 digest (Sonnet) → _Today.pdf back to tablet + Teams/ntfy · reminder sweep · Sunday review (Opus)
```

Model tiering: **Sonnet** transcribes (handwriting accuracy is the whole game), **Haiku** dedupes carried-forward items,
**Sonnet** writes the daily plan, and **Opus** writes the weekly review. Transcription instructions and the open-loop list are prompt-cached;
the nightly run uses the Batch API. On weekdays a 6:15am top-up and reads at 8, 10, 12, 2, and 4 run sync, so the
day's writing shows up the same day. Every page's
ink is fingerprinted, so a page is only re-transcribed when it actually changes. Token use is tracked at `/api/status`.

## Setup on Umbrel

Gleaner ships in the **Herman Apps** community store (`mherman1990/spotter-umbrel-store`, the same store as Spotter) as
`herman-gleaner`. If Spotter is installed, the store is already added; otherwise add the store repo's URL under
App Store → ⋯ → Community App Stores.

1. **Install** Gleaner from Herman Apps in the Umbrel UI.
2. **Secrets and config:** create `~/umbrel/app-data/herman-gleaner/data/gleaner.env` from `config/gleaner.env.example`.
   Set at least `ANTHROPIC_API_KEY`. A `config.json` is optional; see `config/config.example.json`. Restart the app.
   `/api` stays disabled until it has a token: see [API](#api) for `token add`.
3. **Register rmapi with your reMarkable account** (one time). Get a code at
   `https://my.remarkable.com/device/browser/connect`, then:
   ```
   sudo docker exec -it herman-gleaner_web_1 sh -c 'RMAPI_CONFIG=/data/secrets/rmapi.conf rmapi'
   ```
   Paste the code at the prompt, then `exit`. The token is saved to `data/secrets/rmapi.conf`.
4. **Check everything:** `sudo docker exec herman-gleaner_web_1 node src/cli.js doctor`. Confirm `source.documents` > 0
   and that `findSample` looks like JSON. If rmapi's output format differs, this is where you'll see it.
5. **First run:** `sudo docker exec herman-gleaner_web_1 node src/cli.js ingest --sync`, then read `data/notes/` and
   `node src/cli.js items`. Tune the notation or tag list before trusting the nags.
6. **Delivery (optional):** set `GLEANER_TEAMS_WEBHOOK` (Power Automate *When a Teams webhook request is received* →
   *Post card in a chat or channel*, same pattern as polibrief) and/or `GLEANER_NTFY_URL`.
7. **Claude layer:** set up the two Cowork tasks in `cowork/`.

On the tablet, create a `/Daily` folder and keep daily notebooks in it. See `docs/HANDWRITING.md` for the notation.

## Day to day

| Where | How |
|---|---|
| Tablet | Write `✓14` / `x14` / `14 → Fri` on today's page; it's applied that night. `2pm` and `@Jen` on an item line set its time and assignee |
| Browser | Umbrel → Gleaner: open loops with Done / Snooze / Drop (each with Undo) and Edit (text, due date, time, assigned to); snoozed and recently closed items with Reopen; *Ingest now* |
| CLI | `node src/cli.js done 14` · `snooze 14 2026-10-23` · `reopen 14` · `due 14 2026-10-23 2pm` · `assign 14 Jen` · `items [snoozed\|closed\|all]` · `digest --push` · `retranscribe "To do"` |
| Claude | Ask in Cowork. Desktop Commander can `curl` `/api/items`, `/api/notes`, `/api/search?q=`, `POST /api/items/14 {"status":"done"}`, and `POST /api/items {"text":"…"}` |

**Edits by hand win.** A field you set in the browser, CLI, or API (text, due date and time, assignee) is never
overwritten when the page is read again. Fields you haven't touched still follow the page. Items assigned to someone
are listed under *Waiting on others*. An item due at a time is nudged on the first reminder sweep within 30 minutes of
it (`reminders.leadMinutes`); sweeps run every 30 minutes, 7am to 6:30pm on weekdays. Nudges go to Teams and/or
ntfy, and one only counts toward `maxNudgesPerItem` once a channel accepted it, so nothing is used up while neither
is set.

**Task-list notebooks.** In notebooks listed under `notebooks.taskLists` in `config.json` (default `["To do"]`),
every written line is a to-do, with or without the notation. Elsewhere only marked lines become items.

**Re-reading pages.** A page is transcribed again only when its ink changes. After changing the model, the prompts,
or `taskLists`, run `node src/cli.js retranscribe` with `all`, a date (`2026-10-17`), or a notebook name
(`"To do"`). Items keep their numbers. Each page re-read is a new Claude call, so `all` costs what the first
pass did.

## Project registry

`/data/projects.yaml` on the Pi lists your projects. Each has:
- a canonical tag and its aliases;
- a program, status, sensitivity (`normal` or `restricted`), funding, and search hints for Cowork.

The file also lists the short forms you write for people, and context tags. See `config/projects.example.yaml`
for the format. The real file never goes in this repo, which is public; any file named `projects.yaml` is git-ignored.

- **Transcription:** the registry is part of the cached system prompt. An alias, a case variant, or a stray `#`
  (`#kites`, `KS`, `kite-study`) is stored as the one canonical tag. Values are read as written: an alias `12.40`
  stays `12.40`. A name in `write_as` becomes the full name, and a first name shared by two people stays
  as written with `person_ambiguous`. A re-read that gives only the first name of the person already stored
  (`Alex` after `Alex Two`) keeps the full name.
- **Unknown tags:** a tag the registry doesn't cover is kept as written. The API shows it under
  `unregistered_tags`, and the Sunday review lists it with a count, so you can add it.
- **Editing:** Gleaner notices a changed file by itself. First check the file, either in the app
  (`node src/cli.js registry check /data/projects.yaml`) or on any computer with Node 22 and this repo, after `npm ci`
  (`node scripts/check-registry.mjs ~/gleaner/projects.yaml`, with the file kept outside the repo; a copy named
  `projects.yaml` inside it is git-ignored anyway). A file that fails the check is ignored, and the last good
  version stays in use, including after a restart and in CLI commands: every valid version is saved next to the
  file as `.projects.yaml.last-good`. `doctor` shows which is in use and why. A key the format doesn't use (a
  typo such as `alias:`) is reported as a warning.
- **Run log:** every read logs the registry version (a hash of the file).
- **Without a registry:** the flat `tags` list in `config.json` seeds the transcriber instead.

## API

`GET /api/items[?status=open|snoozed|closed|all&tag=45Z]` · `GET /api/items/:code` ·
`POST /api/items/:code {status: done|dropped|open|snoozed, until, text, due, due_time, person, assignee}` (any of them; `null` clears) ·
`POST /api/items[?dry_run=1] {text, due, due_time, person, assignee, tags, priority, kind, source, source_ref}` (only `text` is needed) ·
`GET /api/open-loops.md` · `GET /api/digest/today` · `GET /api/notes[?from&to]` · `GET /api/notes/:date` ·
`GET /api/search?q=` · `GET /api/events[?since&client]` · `POST /api/ingest {mode: sync|batch}` · `POST /api/digest {push}` ·
`GET /api/status`

**Tokens.** Every `/api` request needs `Authorization: Bearer <token>`, and each client has its own. Make one on the Pi:
```
sudo docker exec herman-gleaner_web_1 node src/cli.js token add mayer --scopes all --sensitivity all
```
It prints the token once; `/data/tokens.json` keeps only its sha256 hash (mode 0600). `token list` shows the clients
and `token revoke <client>` removes one; both take effect without a restart. `GLEANER_API_TOKEN` still works through
v0.2.x, as client `legacy` with every scope. With no token at all, `/api` is disabled (503). The browser UI uses
`/ui-api`, behind Umbrel's login, as client `ui`.

| Scope | Routes |
|---|---|
| `read` | every `GET` above |
| `write` | `POST /api/items/:code` |
| `ingest` | `POST /api/ingest` |
| `digest` | `POST /api/digest` |
| `create` | `POST /api/items` |

**Sensitivity.** A token made with `--sensitivity normal` (the default) never gets restricted work back: projects
marked `sensitivity: restricted` in the registry. An item is left out if any of its tags is, or ever was, restricted,
or if it was written on a page that is, or ever was, tagged with one. A page is left out whole if it has or had a
restricted tag, or if it holds, carries, ticks off or closes by number a restricted item, even after a later read of
the page no longer shows that. Notes are rendered without those pages, and search, events, open loops and the page
counts in `status` leave them out too; a close by number keeps its words to itself. The digest covers all work, so it's
a 403. With no registry loaded nothing can be judged, so these tokens get 503 until one is. Hiding errs wide: a page
once tagged restricted stays hidden after it's erased and written over.

**Creating items.** `POST /api/items` adds an item for another app: `{"text": "Send Jen the budget", "due": "2026-10-23",
"tags": ["budget"], "source": "email", "source_ref": "<the email's id>"}`. It's checked against the open loops first, as
a new handwritten line is: if an open item is the same task, that item gets the new details it lacks (due date, person,
assignee, tags) and the reply is `merged`; its own text, and anything you set or cleared by hand, stay. Tags a client
gives an item are kept when its page is read again. Sending the same `source` and `source_ref` again changes nothing
(`existing`), even after that item is closed. Otherwise the reply is `created` (201) with the item's number. The answer
comes within 15 seconds (`api.createBudgetSeconds`), else it's `queued` (202) and the item follows in the background; a
request that failed is retried at each ingest for a week. `?dry_run=1` answers `existing`, `would_create` or
`would_merge` and writes nothing. `source` defaults to `api`. Items created this way aren't dropped when a line written
for them is erased. A token at sensitivity `normal` never gets the number of an item it can't see.

**Audit trail.** Every change to an item writes a row per changed field to `events`: who (`handwriting`, `erased`,
`ui`, `cli`, `legacy`, or the token's client), the item, the field, and the old and new values. `closed_by` is the
client too. `GET /api/events?since=today|YYYY-MM-DD|<ISO time>&client=mayer` lists them, oldest first (default: the
last 24 hours). It returns at most 1,000; the header `X-More: true` means there are more, so ask again with
`&after=<the last event's id>`. The morning digest says what people and clients changed since the last digest, e.g.
"Mayer closed 3, dropped 1 (see events)."

Items carry `tags`, `unregistered_tags` (tags the registry doesn't cover) and `person_ambiguous` (the person or
assignee is a first name two registry people share). Both are worked out against the registry in use when the item
is returned, so they follow its edits. `?tag=` takes a canonical tag or any alias, in any case.

## Releases

Bump `version` in `package.json`, update `releaseNotes` in `umbrel-store/herman-gleaner/umbrel-app.yml`, merge, then push
a matching tag (`git tag v0.2.0 && git push origin v0.2.0`). The *Release* workflow:

1. builds the arm64 + amd64 image and pushes `ghcr.io/mherman1990/gleaner:<version>` (and `:latest`);
2. copies `umbrel-store/herman-gleaner/` into the Herman Apps store repo, pins the new digest
   (`scripts/bump-store.mjs`), validates the store (`scripts/check-store.mjs`), and pushes. Umbrel then offers the update.

Edit the app's store listing here, in `umbrel-store/herman-gleaner/`, not in the store repo. The store's `README.md` and
`umbrel-app-store.yml` belong to the spotter repo's `umbrel-store/`, which Spotter's release syncs.

**One-time setup for step 2**, in this repo's Settings → Secrets and variables → Actions:
- variable `STORE_REPO` = `mherman1990/spotter-umbrel-store`
- secret `STORE_REPO_TOKEN` = a fine-grained personal access token with *Contents: Read and write* on that one repo
  (the same kind Spotter uses; GitHub won't show Spotter's existing secret, so paste the token again or make a new one).

Without them, step 1 still runs and step 2 is skipped.

## Known limits (v0.1)

- **rmapi uses an unofficial, reverse-engineered protocol.** If reMarkable changes it, ingestion stops, but notes and the
  ledger keep working. Pinned to ddvk/rmapi v0.0.35.
- Only notebooks are read. Annotated PDFs and ebooks are skipped, and so is anything named `_…` (including the Today sheet).
- Erasing a line drops its item, but only if that item appears on no other page.
- The SSH/USB adapter exists for a future non-Connect setup; it is untested on hardware.
- **Privacy:** page images are sent to the Anthropic API. Keep anything you don't want processed outside `/Daily`.

## Development

Node 22, plus the renderer on `PATH`: `pip install rmc==0.3.0 rmscene==0.6.1 cairosvg==2.7.1` (cairosvg needs the
system `libcairo2`). Then:

- `npm ci && npm test` runs the test suite: ledger semantics against canned model output, the rmapi adapter against
  a fake `rmapi` that mimics v0.0.35's real output, and the whole pipeline plus the HTTP API end to end. Without the
  renderer installed, the end-to-end tests are skipped. It also checks the Umbrel store package against the rules
  Spotter's release enforces on every app in the shared store. CI runs the same suite and builds the image on every PR.
- `npm run test:fixture` runs one ingest and digest into `./.testdata` so you can read the markdown it produces.

Fixture layout is `fixtures/<Notebook>/<NN>.rm` (sample pages from the rmc project; see `fixtures/README.md`).
Mock mode (`GLEANER_LLM=mock`) runs the whole pipeline with no API key.
