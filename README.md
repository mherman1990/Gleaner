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
the nightly run uses the Batch API, and the 6:15am top-up runs sync for anything written late. Every page's
ink is fingerprinted, so a page is only re-transcribed when it actually changes. Token use is tracked at `/api/status`.

## Setup on Umbrel

Gleaner ships in the **Herman Apps** community store (`mherman1990/spotter-umbrel-store`, the same store as Spotter) as
`herman-gleaner`. If Spotter is installed, the store is already added; otherwise add the store repo's URL under
App Store → ⋯ → Community App Stores.

1. **Install** Gleaner from Herman Apps in the Umbrel UI.
2. **Secrets and config:** create `~/umbrel/app-data/herman-gleaner/data/gleaner.env` from `config/gleaner.env.example`.
   Set at least `ANTHROPIC_API_KEY` and `GLEANER_API_TOKEN` (without a token, `/api` stays disabled). A `config.json`
   is optional; see `config/config.example.json`. Restart the app.
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
| Tablet | Write `✓14` / `x14` / `14 → Fri` on today's page; it's applied that night |
| Browser | Umbrel → Gleaner: open loops with Done / Fri / Drop buttons, plus *Ingest now* |
| CLI | `node src/cli.js done 14` · `snooze 14 2026-10-23` · `items` · `digest --push` |
| Claude | Ask in Cowork. Desktop Commander can `curl` `/api/items`, `/api/notes`, `/api/search?q=`, and `POST /api/items/14 {"status":"done"}` |

## API (Bearer token)

`GET /api/items[?status=all&tag=45Z]` · `POST /api/items/:code {status: done|dropped|open|snoozed, until}` ·
`GET /api/open-loops.md` · `GET /api/digest/today` · `GET /api/notes[?from&to]` · `GET /api/notes/:date` ·
`GET /api/search?q=` · `POST /api/ingest {mode: sync|batch}` · `POST /api/digest {push}` · `GET /api/status`

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
