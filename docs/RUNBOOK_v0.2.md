# Gleaner v0.2 — runbook (the steps only Matt can do)

The steps here touch the Pi, the tablet, credentials, Telegram/Signal, Tailscale or Cowork, so they're Matt's, not
code. Each section is added when its build step lands (`docs/IMPLEMENTATION_PLAN.md`). Commands assume an SSH
session on the Umbrel as `umbrel`. The app's data folder is `~/umbrel/app-data/herman-gleaner/data`, which the app
sees as `/data`.

---

## Step 1 — Project registry

Safe to do before upgrading: v0.1.x ignores the file.

1. **Copy your registry to the Pi.** From your PC, in the folder holding your `projects.yaml`:
   ```
   scp projects.yaml umbrel@umbrel.local:/tmp/projects.yaml
   ```
   Then on the Pi:
   ```
   sudo install -o 1000 -g 1000 -m 0640 /tmp/projects.yaml ~/umbrel/app-data/herman-gleaner/data/projects.yaml && rm /tmp/projects.yaml
   ```
2. **Check it** (after upgrading to the release with step 1):
   ```
   sudo docker exec herman-gleaner_web_1 node src/cli.js registry check /data/projects.yaml
   ```
   Expect the version hash, the project count, and the list of restricted tags. Errors name the tag at fault.
3. **Confirm Gleaner uses it:**
   ```
   sudo docker exec herman-gleaner_web_1 node src/cli.js doctor
   ```
   Under `registry`, expect `"loaded": true`, `"source": "file"`, the same version, and `"errors": null`. From then
   on, every read logs `[ingest] registry <version>`.
4. **Re-read existing pages** so their tags and names go through the registry. This costs one Claude call per page
   (a few cents each). Item numbers don't change.
   ```
   sudo docker exec herman-gleaner_web_1 node src/cli.js retranscribe all
   ```

**Editing later:**
1. Edit the file on your PC. If Node 22 and a copy of this repo are on that PC, you can check it there first: run
   `npm ci` once in the repo folder, then, from that folder, point the check at wherever the file lives (keep it
   outside the repo):
   `node scripts/check-registry.mjs ~/gleaner/projects.yaml`.
2. Copy it over with step 1.
3. Run the check in step 2.

No restart is needed. Gleaner picks up a valid file on its next use. A file that fails the check is ignored, and the
last good version stays in use: every valid version is saved next to the file as `.projects.yaml.last-good`, so this
holds after a restart too. `doctor` shows `"source": "last-good"` and the errors until the file is fixed.

Each Sunday review ends with **Unregistered tags**: tags you wrote that the registry doesn't cover, with counts. Add
the keepers as projects or aliases.

---

## Step 2 — API tokens

After upgrading to the release with step 2. Each client gets its own token: who did what shows up in the events, and
`cowork-notebook` can't see restricted projects.

1. **Create the tokens**, on the Pi. Each command prints its token once; only its hash is kept, so save it right away
   (a password manager is fine until the client that uses it is set up in steps 5–8):
   ```
   sudo docker exec herman-gleaner_web_1 node src/cli.js token add mayer --scopes all --sensitivity all
   sudo docker exec herman-gleaner_web_1 node src/cli.js token add mcp --scopes all --sensitivity all
   sudo docker exec herman-gleaner_web_1 node src/cli.js token add cowork-plan --scopes read,create,write --sensitivity all
   sudo docker exec herman-gleaner_web_1 node src/cli.js token add cowork-notebook --scopes read --sensitivity normal
   ```
2. **Check them:** `sudo docker exec herman-gleaner_web_1 node src/cli.js token list` shows the four clients, with no
   tokens or hashes. `doctor` shows the same under `tokens`.
3. **Check the filter** (needs your registry from step 1). From a computer on your home network, with the
   `cowork-notebook` token (away from home, over Tailscale, use the Pi's MagicDNS name instead of `umbrel.local`):
   ```
   curl -s -H "Authorization: Bearer <cowork-notebook token>" "http://umbrel.local:3717/api/items?status=all"
   ```
   No item from a restricted project should be in it. The same request with the `mayer` token includes them.
   Pages read before this upgrade: the upgrade links each one to the items it closed or snoozed by number (`✓14`,
   `✓14, 15`, `✓ 12–15`, `x14`, `14 → Fri`) and to the items whose close quoted its words, and keeps every page's
   current tags. Two things from before the upgrade can't be recovered: a box ticked on an unrestricted page that
   closed a restricted item from another page, and a restricted tag that an earlier re-read had already dropped. If
   either may apply, read the notes for those days with the `cowork-notebook` token:
   `curl -s -H "Authorization: Bearer <cowork-notebook token>" "http://umbrel.local:3717/api/notes?from=2026-10-01&to=2026-10-31"`.
   Anything restricted in it can be hidden by tagging that page's line on the tablet (`#mb` with your restricted tag),
   which takes effect on the next read.
4. **The old token** (`GLEANER_API_TOKEN`) keeps working as client `legacy` through v0.2.x, so nothing breaks today.
   Once every client uses its own token, delete that line from `gleaner.env`, restart the app, and rename the old
   token file on your PC to `.gleaner-token.legacy`.

To revoke a token (lost, or a client retired): `node src/cli.js token revoke <client>`. It takes effect at once.

---

## Step 4 — Projects and health

After updating Gleaner to the release with step 4 (v0.2.2).

1. **Look at the health report** on the Pi:
   ```
   sudo docker exec herman-gleaner_web_1 node src/cli.js health
   ```
   `jobs` shows when the nightly batch, the daytime sync and the morning digest last succeeded. `source.auth` fills in
   after the first check, at :07, :22, :37 or :52 past the hour between 6:00am and 10:00pm (or run `health --check`).
   `usage` is the estimated API spend; `memory` and `disk` are the Pi's.
2. **Update the Claude extension to 1.1.0** on each computer: drag `gleaner-1.1.0.mcpb` onto **Settings →
   Extensions**, as in step 7. If it asks again, enter the same address and that computer's token. Then ask Claude
   "brief me on <a project>": it should call `get_project`. Compare its open items with what you see for that tag in
   Gleaner's browser page.
3. **Alerts need a channel.** They go out through the notify channels, and Teams and ntfy are unset, so until
   Telegram (step 5) an alert only shows in `/api/health` and `cli.js health` under `alerts`.
4. **After step 5, the acceptance check:** stop the reMarkable sign-in for a moment by moving rmapi's config aside,
   in the daytime (not during the 9:30pm batch):
   ```
   sudo mv ~/umbrel/app-data/herman-gleaner/data/secrets/rmapi.conf ~/umbrel/app-data/herman-gleaner/data/secrets/rmapi.conf.off
   sudo docker exec herman-gleaner_web_1 node src/cli.js health --check
   ```
   One alert arrives. Running `health --check` again sends nothing (`last_sent` stays put) until 6 hours have passed.
   Put it back and check again; the alert clears:
   ```
   sudo mv ~/umbrel/app-data/herman-gleaner/data/secrets/rmapi.conf.off ~/umbrel/app-data/herman-gleaner/data/secrets/rmapi.conf
   sudo docker exec herman-gleaner_web_1 node src/cli.js health --check
   ```

## Step 7 — Gleaner in the Claude app (local MCP)

Do this on each computer (your own laptop and the ISA one), with a token for each, so the change log tells them apart.
Both need Tailscale on to reach the Pi away from home. The details and troubleshooting are in `gleaner-mcp/README.md`.

1. **A token per computer**, on the Pi:
   ```
   sudo docker exec herman-gleaner_web_1 node src/cli.js token add claude-home --scopes read,write,create --sensitivity all
   sudo docker exec herman-gleaner_web_1 node src/cli.js token add claude-work --scopes read,write,create --sensitivity all
   ```
   Each prints its token once.
2. **Install the extension** (`gleaner-<version>.mcpb`, e.g. `gleaner-1.1.0.mcpb`) in the Claude app: double-click it, or drag it onto
   **Settings → Extensions**. Its settings ask for:
   - the **Gleaner address**: `http://umbrel:3717`, the Pi's Tailscale name. Use whatever opens Gleaner in this
     computer's browser, with `:3717`.
   - the **Gleaner token**: that computer's token from step 1.
3. **Check it:** in a new chat, ask "What's open on my Gleaner list?" Claude should list your items. Then tick one
   off from the chat ("mark 14 done") and see it close in Gleaner's browser page, as `claude-home`.
4. **The artifact:** once the extension works, Claude publishes the Gleaner artifact. Open it in the Claude app; the
   first change it makes may ask you to allow the extension's tools.

To stop a computer's access, revoke its token (`token revoke claude-work`). Uninstalling the extension removes it
from that computer.
