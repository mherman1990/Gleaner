#!/usr/bin/env node
// gleaner <command>
//   doctor            check source adapter + auth + renderer
//   ingest [--sync]   pull/transcribe now (default: batch)
//   digest [--push]   build the morning digest (and push Today sheet / notifications with --push)
//   remind            run the reminder sweep once
//   weekly [--push]   build the weekly review
//   items [snoozed|closed|all]   print open loops (or the others, with their numbers)
//   retranscribe all | YYYY-MM-DD | "<notebook>"   read those pages again now (after a prompt/model change)
//   done <code> | drop <code> | snooze <code> <YYYY-MM-DD> | reopen <code>
//   due <code> <YYYY-MM-DD> [time] | due <code> none     set or clear the due date and time (14:00, 2pm)
//   assign <code> <name> | assign <code> none
//   registry check [file]   validate a projects.yaml (default: the one in use) before deploying it
//   token add <client> --scopes read,write|all [--sensitivity normal|all]   prints the new token once
//   token revoke <client> | token list
// Changes made here are attributed to client "cli".
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { config } from './config.js';
import { db, setItemStatus, editItem, listItems } from './db.js';
import { source } from './adapters/index.js';
import { ingest, markForRetranscription } from './pipeline/ingest.js';
import { morningDigest, reminderSweep, weeklyReview } from './digest/digest.js';
import { renderOpenLoops, refreshItemOutputs, itemLine } from './output/markdown.js';
import { parseRegistry, registryStatus } from './registry.js';
import { addToken, revokeToken, tokenStatus } from './auth.js';
import { doctor as inboxDoctor } from './adapters/api-inbox.js';

const [cmd, ...args] = process.argv.slice(2);
const flag = (f) => args.includes(f);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
function itemByCode(code) {
  const item = db.prepare('SELECT id FROM items WHERE code=?').get(Number(code));
  if (!item) throw new Error(`no item #${code}`);
  return item;
}

async function main() {
  switch (cmd) {
    case 'doctor': {
      const out = { config: { source: config.source.adapter, folder: config.source.folder, llm: config.llm.mode, models: { t: config.llm.transcribeModel, d: config.llm.digestModel, w: config.llm.weeklyModel, h: config.llm.triageModel }, taskLists: config.notebooks.taskLists } };
      try { out.rmc = execFileSync('rmc', ['--version']).toString().trim(); } catch (e) { out.rmc = `missing: ${e.message}`; }
      out.apiKey = !!process.env.ANTHROPIC_API_KEY;
      out.registry = registryStatus();
      out.tokens = tokenStatus();
      out.source = await source().doctor().catch((e) => ({ error: e.message }));
      out.inbox = inboxDoctor();
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    case 'ingest': console.log(await ingest({ mode: flag('--sync') ? 'sync' : 'batch' })); break;
    case 'digest': console.log((await morningDigest({ push: flag('--push') })).md); break;
    case 'remind': console.log(await reminderSweep()); break;
    case 'weekly': console.log((await weeklyReview({ push: flag('--push') })).md); break;
    case 'items': {
      if (!args[0] || args[0] === 'open') { console.log(renderOpenLoops()); break; }
      const rows = listItems(args[0]);
      console.log(rows.map((i) => `${itemLine(i)}${i.status === 'snoozed' ? ` until ${i.snooze_until}` : ''}`).join('\n') || 'none');
      break;
    }
    case 'retranscribe': {
      if (!args[0]) throw new Error('usage: retranscribe all | YYYY-MM-DD | "<notebook name>"');
      const n = markForRetranscription(args[0]);
      console.log(`${n} page(s) to read again`);
      if (n) console.log(await ingest({ mode: 'sync' }));
      break;
    }
    case 'done': case 'drop': case 'snooze': case 'reopen': {
      const item = itemByCode(args[0]);
      if (cmd === 'snooze' && !/^\d{4}-\d{2}-\d{2}$/.test(args[1] || '')) throw new Error('usage: snooze N YYYY-MM-DD');
      setItemStatus(item.id, { done: 'done', drop: 'dropped', snooze: 'snoozed', reopen: 'open' }[cmd], 'cli', null, cmd === 'snooze' ? args[1] : null);
      refreshItemOutputs([item.id]);
      console.log(`#${args[0]} → ${cmd}`);
      break;
    }
    case 'registry': {
      if (args[0] !== 'check') throw new Error('usage: registry check [file]');
      const file = args[1] || config.registry.path;
      try {
        const r = parseRegistry(fs.readFileSync(file, 'utf8'));
        console.log(JSON.stringify({ file, version: r.version, projects: r.projects.length,
          restricted: r.projects.filter((p) => p.sensitivity === 'restricted').map((p) => p.tag),
          people: r.people.length, contexts: r.contexts, warnings: r.warnings }, null, 2));
      } catch (e) {
        console.error(`${file} is not valid:\n${(e.errors || [e.message]).map((x) => `  - ${x}`).join('\n')}` +
          `${e.warnings?.length ? `\nwarnings (a typo here may explain an error):\n${e.warnings.map((x) => `  - ${x}`).join('\n')}` : ''}`);
        process.exitCode = 1;
      }
      break;
    }
    case 'due': case 'assign': {
      const item = itemByCode(args[0]);
      const rest = args.slice(1);
      if (!rest.length) throw new Error(cmd === 'due' ? 'usage: due N YYYY-MM-DD [time] | due N none' : 'usage: assign N <name> | assign N none');
      const none = rest[0] === 'none';
      editItem(item.id, cmd === 'assign' ? { assignee: none ? null : rest.join(' ') }
        : none ? { due: null } : { due: rest[0], due_time: rest.slice(1).join(' ') || null }, 'cli');
      refreshItemOutputs([item.id]);
      console.log(itemLine(db.prepare('SELECT * FROM items WHERE id=?').get(item.id)));
      break;
    }
    case 'token': {
      const [sub, client] = args;
      if (sub === 'add' && client) {
        const token = addToken(client, { scopes: option('--scopes'), sensitivity: option('--sensitivity') ?? 'normal' });
        const t = tokenStatus().clients.find((c) => c.client === client);
        console.log(`${client}: scopes ${t.scopes.join(', ')}; sensitivity ${t.sensitivity}\n` +
          `Token (shown once, only its hash is kept; save it where ${client} reads it):\n${token}`);
      } else if (sub === 'revoke' && client) {
        console.log(revokeToken(client) ? `${client}: revoked` : `${client} has no token`);
      } else if (sub === 'list') {
        const s = tokenStatus();
        if (s.error) console.log(`${s.path} is ignored: ${s.error}`);
        console.log(s.clients.map((c) => `${c.client}\t${c.scopes.join(',')}\t${c.sensitivity}\t${c.created ?? ''}`).join('\n') || 'no tokens');
        if (s.legacy) console.log('legacy\tall\tall\t(GLEANER_API_TOKEN)');
      } else throw new Error('usage: token add <client> --scopes read,write|all [--sensitivity normal|all] | token revoke <client> | token list');
      break;
    }
    default:
      console.log('usage: gleaner doctor | ingest [--sync] | digest [--push] | remind | weekly [--push] | items [snoozed|closed|all] | retranscribe all|YYYY-MM-DD|"<notebook>" | done N | drop N | snooze N YYYY-MM-DD | reopen N | due N YYYY-MM-DD [time] | due N none | assign N <name> | assign N none | registry check [file] | token add <client> --scopes … [--sensitivity …] | token revoke <client> | token list');
  }
}
main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e.message); process.exit(1); });
