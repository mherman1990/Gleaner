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

1. **Build and push the image** (arm64 for the Pi):
   `docker buildx build --platform linux/arm64,linux/amd64 -t ghcr.io/<you>/gleaner:0.1.0 --push .`
2. **Add to your community app store** (same repo as Spotter): copy `umbrel/` to `<store-id>-gleaner/`, replace every
   `CHANGE-ME`, and pin the image by digest. Install it from the Umbrel UI.
3. **Secrets and config:** in `~/umbrel/app-data/<store-id>-gleaner/data/`, create `gleaner.env` from
   `config/gleaner.env.example`. A `config.json` is optional; see `config/config.example.json`. Restart the app.
4. **Register rmapi with your reMarkable account** (one time). Get a code at
   `https://my.remarkable.com/device/desktop/connect`, then:
   ```
   sudo docker exec -it <store-id>-gleaner_web_1 sh -c 'RMAPI_CONFIG=/data/secrets/rmapi.conf rmapi'
   ```
   Paste the code at the prompt, then `exit`. The token is saved to `data/secrets/rmapi.conf`.
5. **Check everything:** `sudo docker exec <container> node src/cli.js doctor`. Confirm `source.documents` > 0 and
   that `findSample` looks like JSON. If rmapi's output format differs, this is where you'll see it.
6. **First run:** `sudo docker exec <container> node src/cli.js ingest --sync`, then read `data/notes/` and
   `node src/cli.js items`. Tune the notation or tag list before trusting the nags.
7. **Delivery (optional):** set `GLEANER_TEAMS_WEBHOOK` (Power Automate *When a Teams webhook request is received* →
   *Post card in a chat or channel*, same pattern as polibrief) and/or `GLEANER_NTFY_URL`.
8. **Claude layer:** set up the two Cowork tasks in `cowork/`.

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

## Known limits (v0.1)

- **rmapi uses an unofficial, reverse-engineered protocol.** If reMarkable changes it, ingestion stops, but notes and the
  ledger keep working. Pinned to ddvk/rmapi v0.0.35.
- Only notebooks are read. Annotated PDFs and ebooks are skipped, and so is anything named `_…` (including the Today sheet).
- Erasing a line drops its item, but only if that item appears on no other page.
- The SSH/USB adapter exists for a future non-Connect setup; it is untested on hardware.
- **Privacy:** page images are sent to the Anthropic API. Keep anything you don't want processed outside `/Daily`.

## Development

`npm install`, then
`GLEANER_SOURCE=fixture GLEANER_LLM=mock GLEANER_DATA_DIR=./.testdata GLEANER_FIXTURE_DIR=./fixtures node src/cli.js ingest`.
Fixture layout is `fixtures/<Notebook>/<NN>.rm`. Mock mode runs the whole pipeline with no API key.
