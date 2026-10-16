// Delivery adapters. Each is optional; unconfigured ones are skipped silently.
//  - Teams: same Power Automate webhook pattern as polibrief (Adaptive Card envelope).
//  - ntfy: self-hosted push to phone/watch — the one that actually interrupts you.
//  - tablet: replaces the _Today PDF in the configured folder.
import { config } from '../config.js';
import { source } from '../adapters/index.js';

async function teams({ title, body }) {
  const url = config.notify.teamsWebhookUrl;
  if (!url) return 'skipped';
  const card = {
    type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4',
    body: [
      { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
      { type: 'TextBlock', text: body, wrap: true, spacing: 'Small' },
    ],
  };
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: card }] }),
  });
  return r.ok ? 'ok' : `http ${r.status}`;
}

async function ntfy({ title, body, priority = 'default' }) {
  const url = config.notify.ntfyUrl;
  if (!url) return 'skipped';
  const r = await fetch(url, {
    method: 'POST', body,
    headers: { Title: title.replace(/[^\x20-\x7E]/g, ''), Priority: priority, Tags: 'memo' },
  });
  return r.ok ? 'ok' : `http ${r.status}`;
}

export async function notify(msg) {
  const out = {};
  for (const [k, fn] of Object.entries({ teams, ntfy })) {
    try { out[k] = await fn(msg); } catch (e) { out[k] = `error: ${e.message}`; }
  }
  return out;
}

export async function pushToTablet(pdfPath) {
  const ok = await source().upload(pdfPath, config.notify.tabletTodayFolder);
  return ok ? 'ok' : 'unsupported by adapter';
}
