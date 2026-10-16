import cron from 'node-cron';
import { config } from './config.js';
import { ingest } from './pipeline/ingest.js';
import { morningDigest, reminderSweep, weeklyReview } from './digest/digest.js';

const jobs = {
  ingestNightly: () => ingest({ mode: 'batch' }),
  ingestMorning: () => ingest({ mode: 'sync' }),
  morningDigest: () => morningDigest({ push: true }),
  reminderSweep: () => reminderSweep(),
  weeklyReview: () => weeklyReview({ push: true }),
};

export function startScheduler() {
  for (const [name, fn] of Object.entries(jobs)) {
    const expr = config.schedule[name];
    if (!expr) continue;
    cron.schedule(expr, async () => {
      const t = Date.now();
      try { const r = await fn(); console.log(`[cron] ${name} ok in ${Math.round((Date.now() - t) / 1000)}s`, JSON.stringify(r)?.slice(0, 300)); }
      catch (e) { console.error(`[cron] ${name} failed:`, e.message); }
    }, { timezone: config.timezone, name, noOverlap: true });
    console.log(`[cron] ${name.padEnd(14)} ${expr} (${config.timezone})`);
  }
}
