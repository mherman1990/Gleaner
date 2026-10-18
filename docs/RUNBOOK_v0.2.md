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
