// Thin wrapper over the Anthropic SDK.
// - Forced tool use for structured output (works identically in sync and Batch).
// - cache_control on the static system prompt and on the per-run open-loop block.
// - mode "mock" returns deterministic fake output so the whole pipeline runs offline.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logUsage } from '../db.js';
import { mockFor } from './mock.js';

let client;
const api = () => (client ??= new Anthropic()); // reads ANTHROPIC_API_KEY

const cached = (text) => ({ type: 'text', text, cache_control: { type: 'ephemeral' } });

/** Build Messages API params for a forced-tool call. systemBlocks: string[] (each cached). */
export function toolParams({ model, systemBlocks, content, tool, maxTokens = 4096 }) {
  return {
    model,
    max_tokens: maxTokens,
    system: systemBlocks.map(cached),
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
    messages: [{ role: 'user', content }],
  };
}

function toolInput(message, toolName) {
  const block = message.content?.find((b) => b.type === 'tool_use' && b.name === toolName);
  if (!block) throw new Error(`model did not call ${toolName} (stop_reason=${message.stop_reason})`);
  return block.input;
}

export async function callTool(params, purpose) {
  if (config.llm.mode === 'mock') return mockFor(params);
  const msg = await api().messages.create(params);
  logUsage(params.model, purpose, msg.usage, false);
  return toolInput(msg, params.tool_choice.name);
}

export async function callText({ model, system, content, maxTokens = 2048 }, purpose) {
  if (config.llm.mode === 'mock') return `*(mock ${purpose})*\n\n${typeof content === 'string' ? content.slice(0, 400) : ''}`;
  const msg = await api().messages.create({
    model, max_tokens: maxTokens, system: [cached(system)], messages: [{ role: 'user', content }],
  });
  logUsage(model, purpose, msg.usage, false);
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
export async function collectBatch(batchId, toolName, purpose) {
  if (batchId.startsWith('mock_')) {
    const reqs = mockBatches.get(batchId) || [];
    return new Map(reqs.map((r) => [r.custom_id, { ok: true, input: mockFor(r.params) }]));
  }
  const b = await api().messages.batches.retrieve(batchId);
  if (b.processing_status !== 'ended') return null;
  const out = new Map();
  for await (const r of await api().messages.batches.results(batchId)) {
    if (r.result.type === 'succeeded') {
      logUsage(r.result.message.model, purpose, r.result.message.usage, true);
      try { out.set(r.custom_id, { ok: true, input: toolInput(r.result.message, toolName) }); }
      catch (e) { out.set(r.custom_id, { ok: false, error: e.message }); }
    } else {
      out.set(r.custom_id, { ok: false, error: r.result.type + (r.result.error ? `: ${JSON.stringify(r.result.error)}` : '') });
    }
  }
  return out;
}

const mockBatches = new Map();
