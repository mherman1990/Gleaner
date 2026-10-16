#!/usr/bin/env node
// gleaner <command>
//   doctor            check source adapter + auth + renderer
//   ingest [--sync]   pull/transcribe now (default: batch)
//   digest [--push]   build the morning digest (and push Today sheet / notifications with --push)
//   remind            run the reminder sweep once
//   weekly [--push]   build the weekly review
//   items             print open loops
//   done <code> | drop <code> | snooze <code> <YYYY-MM-DD>
import { execFileSync } from 'node:child_process';
import { config } from './config.js';
import { db, setItemStatus } from './db.js';
import { source } from './adapters/index.js';
import { ingest } from './pipeline/ingest.js';
import { morningDigest, reminderSweep, weeklyReview } from './digest/digest.js';
import { renderOpenLoops, refreshItemOutputs } from './output/markdown.js';

const [cmd, ...args] = process.argv.slice(2);
const flag = (f) => args.includes(f);

async function main() {
  switch (cmd) {
    case 'doctor': {
      const out = { config: { source: config.source.adapter, folder: config.source.folder, llm: config.llm.mode, models: { t: config.llm.transcribeModel, d: config.llm.digestModel, w: config.llm.weeklyModel, h: config.llm.triageModel } } };
      try { out.rmc = execFileSync('rmc', ['--version']).toString().trim(); } catch (e) { out.rmc = `missing: ${e.message}`; }
      out.apiKey = !!process.env.ANTHROPIC_API_KEY;
      out.source = await source().doctor().catch((e) => ({ error: e.message }));
      console.log(JSON.stringify(out, null, 2));
      break;
    }
    case 'ingest': console.log(await ingest({ mode: flag('--sync') ? 'sync' : 'batch' })); break;
    case 'digest': console.log((await morningDigest({ push: flag('--push') })).md); break;
    case 'remind': console.log(await reminderSweep()); break;
    case 'weekly': console.log((await weeklyReview({ push: flag('--push') })).md); break;
    case 'items': console.log(renderOpenLoops()); break;
    case 'done': case 'drop': case 'snooze': {
      const item = db.prepare('SELECT id FROM items WHERE code=?').get(Number(args[0]));
      if (!item) throw new Error(`no item #${args[0]}`);
      if (cmd === 'snooze' && !/^\d{4}-\d{2}-\d{2}$/.test(args[1] || '')) throw new Error('usage: snooze N YYYY-MM-DD');
      setItemStatus(item.id, cmd === 'done' ? 'done' : cmd === 'drop' ? 'dropped' : 'snoozed', 'cli', null, cmd === 'snooze' ? args[1] : null);
      refreshItemOutputs([item.id]);
      console.log(`#${args[0]} → ${cmd}`);
      break;
    }
    default:
      console.log('usage: gleaner doctor | ingest [--sync] | digest [--push] | remind | weekly [--push] | items | done N | drop N | snooze N YYYY-MM-DD');
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
