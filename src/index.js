// Long-running service: HTTP API/UI + scheduled jobs.
import { startServer } from './server.js';
import { startScheduler } from './scheduler.js';
import { config } from './config.js';

console.log(`[gleaner] source=${config.source.adapter} folder=${config.source.folder} llm=${config.llm.mode} tz=${config.timezone}`);
if (config.llm.mode === 'live' && !process.env.ANTHROPIC_API_KEY) console.warn('[gleaner] ANTHROPIC_API_KEY is not set — transcription will fail');
startServer();
startScheduler();
