// The schedule in config.js and the jobs in scheduler.js must line up: a schedule entry without a job is silently
// never run, and node-cron rejects a malformed expression only when the service starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import cron from 'node-cron';
import { tempEnv } from './helpers.js';

tempEnv('schedule');
const { config } = await import('../src/config.js');
const { jobs } = await import('../src/scheduler.js');

test('every schedule entry has a job and a valid cron expression', () => {
  assert.deepEqual(Object.keys(config.schedule).sort(), Object.keys(jobs).sort());
  for (const [name, expr] of Object.entries(config.schedule)) assert.ok(cron.validate(expr), `${name}: ${expr}`);
});

test('weekday reads: 6:15 top-up, then every two hours from 8am to 4pm', () => {
  assert.equal(config.schedule.ingestMorning, '15 6 * * 1-5');
  assert.equal(config.schedule.ingestDaytime, '0 8-16/2 * * 1-5');
});
