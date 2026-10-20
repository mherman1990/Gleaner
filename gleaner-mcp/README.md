# Gleaner for Claude (local MCP server)

Connects the Claude app on your computer to Gleaner on your Pi. Claude, and Claude artifacts opened in the app, can
then read your task ledger and notes, and add, tick off, drop, reopen, snooze and edit items. The Pi keeps the one
record. Every change goes through Gleaner's API with this computer's own token, so Gleaner's change log shows what
Claude did.

It runs on this computer, so it works wherever this computer can reach the Pi: at home, or anywhere over Tailscale.
It doesn't work in claude.ai in a browser or in the phone app.

## Install

1. **Make a token on the Pi**, one per computer, so the change log tells them apart:
   ```
   sudo docker exec herman-gleaner_web_1 node src/cli.js token add claude-home --scopes read,write,create --sensitivity all
   ```
   It prints the token once. Copy it.
2. **Install the extension.** Get `gleaner-<version>.mcpb` (built with `npm run pack:mcpb`, in `gleaner-mcp/dist/`), then
   double-click it, or drag it onto the Claude app's **Settings → Extensions** page.
3. **Fill in its settings:**
   - **Gleaner address:** `http://umbrel:3717` over Tailscale, or `http://umbrel.local:3717` at home. Use whatever opens
     Gleaner in your browser on this computer, including the `:3717` port.
   - **Gleaner token:** the token from step 1.
4. **Check it:** in a new chat, ask "What's on my Gleaner list?" Claude should call `list_items`.

If the extension won't install, add the server to `claude_desktop_config.json` instead (Claude → Settings →
Developer → Edit Config). This needs [Node.js](https://nodejs.org) 18 or later:
```json
{
  "mcpServers": {
    "gleaner": {
      "command": "node",
      "args": ["C:\\path\\to\\gleaner-mcp\\server.mjs"],
      "env": { "GLEANER_URL": "http://umbrel:3717", "GLEANER_TOKEN": "<token>" }
    }
  }
}
```

## Tools

| Tool | Does |
|---|---|
| `list_items` | Open items (default), or snoozed, closed or all; optionally one project tag |
| `get_item` | One item by its number |
| `create_item` | Adds a task. An open item that's the same task gets the new details instead (`merged`); the same `source_ref` again is `existing`. `dry_run` changes nothing |
| `update_item` | `status`: done, dropped, open (reopen), snoozed (with `until`); and edits to text, due date and time, person, assignee |
| `open_loops` | Gleaner's markdown summary of the open items |
| `get_notes` | Transcribed notes for a day, or a range |
| `search_notes` | Pages whose text contains words |
| `list_projects` | Projects from `projects.yaml`, with open, waiting and overdue counts, and unregistered tags |
| `get_project` | One project's briefing: open items by kind, waiting, decisions (90 days), questions, recent page summaries, closes |
| `get_health` | Whether Gleaner is working: alerts, when each job last succeeded, tablet sign-in, spend, memory, disk |
| `list_events` | Recent changes, by whom |

Reads are marked read-only. The Claude app may ask you to confirm the first change it makes.

## When it doesn't work

- **"Can't reach Gleaner":** this computer can't see the Pi. Turn Tailscale on, or check the address in a browser.
- **"didn't accept the token (401)":** the token was revoked, or mistyped. Make a new one (step 1).
- **"isn't allowed (403)":** the token lacks a scope. Make one with `--scopes read,write,create`.

The server is `server.mjs`: one file, no dependencies. `test/mcp.test.js` in the Gleaner repo runs it against a test
Gleaner.
