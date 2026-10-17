// Thin wrapper over the Anthropic SDK.
// - Structured output via output_config.format (JSON schema), identical in sync and Batch. Forced tool use
//   (tool_choice "tool"/"any") is not an option: Claude Sonnet 5.5 and Opus 5.5 reject it with a 400.
// - cache_control on the static system prompt and on the per-run open-loop block.
// - mode "mock" returns deterministic fake output so the whole pipeline runs offline.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logUsage } from '../db.js';
import { mockFor } from './mock.js';

let client;
const api = () => (client ??= new Anthropic()); // reads ANTHROPIC_API_KEY

const cached = (text) => ({ type: 'text', text, cache_control: { type: 'ephemeral' } });

// The 5.5 models always think, and thinking tokens count toward max_tokens. A tight cap cuts the JSON off
// mid-object, while unused headroom costs nothing (billing is per generated token). 16K is the non-streaming
// ceiling that stays clear of SDK HTTP timeouts.
const MAX_TOKENS = 16000;

/** Messages API params for a JSON response matching `schema`. systemBlocks: string[] (each cached). */
export function structuredParams({ model, systemBlocks, content, schema, maxTokens = MAX_TOKENS }) {
  return {
    model,
    max_tokens: maxTokens,
    system: systemBlocks.map(cached),
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  };
}

/** The parsed JSON of a structured response; throws with the reason when there isn't one. */
export function structuredOutput(message) {
  if (message.stop_reason === 'refusal') {
    throw new Error(`model declined${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}`);
  }
  if (message.stop_reason === 'max_tokens') throw new Error('response hit max_tokens before the JSON was complete');
  const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text); }
  catch { throw new Error(`response was not JSON (stop_reason=${message.stop_reason})`); }
}

/** purpose: transcribe | dedupe | digest (also selects the mock's canned output). */
export async function callStructured(params, purpose) {
  if (config.llm.mode === 'mock') return mockFor(params, purpose);
  const msg = await api().messages.create(params);
  logUsage(params.model, purpose, msg.usage, false);
  return structuredOutput(msg);
}

export async function callText({ model, system, content, maxTokens = MAX_TOKENS }, purpose) {
  if (config.llm.mode === 'mock') return `*(mock ${purpose})*\n\n${typeof content === 'string' ? content.slice(0, 400) : ''}`;
  const msg = await api().messages.create({
    model, max_tokens: maxTokens, system: [cached(system)], messages: [{ role: 'user', content }],
  });
  logUsage(model, purpose, msg.usage, false);
  if (msg.stop_reason === 'refusal') throw new Error('model declined');
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// ---- Batch API ---------------------------------------------------------------------------
/** requests: [{ custom_id, params }] → batch id ("mock_…" in mock mode). */
export async function submitBatch(requests) {
  if (config.llm.mode === 'mock') {
    mockBatches.set(`mock_${Date.now()}`, requests);
    return [...mockBatches.keys()].at(-1);
  }
  const batch = await api().messages.batches.create({ requests });
  return batch.id;
}

/** Returns null while in progress; otherwise Map<custom_id, {ok, input?|error}>. */
export async function collectBatch(batchId, purpose) {
  if (batchId.startsWith('mock_')) {
    const reqs = mockBatches.get(batchId) || [];
    return new Map(reqs.map((r) => [r.custom_id, { ok: true, input: mockFor(r.params, purpose) }]));
  }
  const b = await api().messages.batches.retrieve(batchId);
  if (b.processing_status !== 'ended') return null;
  const out = new Map();
  for await (const r of await api().messages.batches.results(batchId)) {
    if (r.result.type === 'succeeded') {
      logUsage(r.result.message.model, purpose, r.result.message.usage, true);
      try { out.set(r.custom_id, { ok: true, input: structuredOutput(r.result.message) }); }
      catch (e) { out.set(r.custom_id, { ok: false, error: e.message }); }
    } else {
      out.set(r.custom_id, { ok: false, error: r.result.type + (r.result.error ? `: ${JSON.stringify(r.result.error)}` : '') });
    }
  }
  return out;
}

const mockBatches = new Map();
