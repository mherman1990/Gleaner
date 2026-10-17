// The request and response shapes for Claude. These can't be exercised against the live API in tests, so they're
// checked against the documented rules instead: structured outputs (output_config.format) accept a JSON Schema
// subset, and Claude Sonnet 5.5 / Opus 5.5 reject forced tool use with a 400.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempEnv } from './helpers.js';

tempEnv('llm');
const { structuredParams, structuredOutput } = await import('../src/llm/client.js');
const { RECORD_PAGE_SCHEMA, MATCH_SCHEMA, DAILY_SCHEMA, transcribeUser } = await import('../src/llm/prompts.js');
const { mockFor } = await import('../src/llm/mock.js');

const SCHEMAS = { RECORD_PAGE_SCHEMA, MATCH_SCHEMA, DAILY_SCHEMA };
const UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
  'maxItems', 'uniqueItems', 'patternProperties', 'not', 'if', 'then', 'else'];
const FORMATS = ['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid'];

/** Every rule violation in a schema, as "path: problem" strings. */
function lint(schema, path = '$') {
  const out = [];
  for (const k of UNSUPPORTED) if (k in schema) out.push(`${path}: "${k}" is not supported`);
  if (Array.isArray(schema.type)) out.push(`${path}: use anyOf instead of a type array`);
  if (schema.format && !FORMATS.includes(schema.format)) out.push(`${path}: format "${schema.format}" is not supported`);
  if (schema.minItems > 1) out.push(`${path}: minItems above 1 is not supported`);
  if (schema.anyOf) schema.anyOf.forEach((s, i) => out.push(...lint(s, `${path}.anyOf[${i}]`)));
  if (schema.type === 'array') out.push(...lint(schema.items, `${path}[]`));
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) out.push(`${path}: additionalProperties must be false`);
    const missing = Object.keys(schema.properties).filter((k) => !schema.required?.includes(k));
    if (missing.length) out.push(`${path}: not required (make them nullable instead): ${missing.join(', ')}`);
    for (const [k, s] of Object.entries(schema.properties)) out.push(...lint(s, `${path}.${k}`));
  }
  return out;
}

/** A small validator for the subset these schemas use. Returns "path: problem" strings. */
function validate(schema, v, path = '$') {
  if (schema.anyOf) {
    const tries = schema.anyOf.map((s) => validate(s, v, path));
    return tries.some((t) => !t.length) ? [] : tries[0];
  }
  const fail = (what) => [`${path}: ${what} (got ${JSON.stringify(v)})`];
  switch (schema.type) {
    case 'null': return v === null ? [] : fail('expected null');
    case 'boolean': return typeof v === 'boolean' ? [] : fail('expected boolean');
    case 'integer': return Number.isInteger(v) ? [] : fail('expected integer');
    case 'string':
      if (typeof v !== 'string') return fail('expected string');
      if (schema.enum && !schema.enum.includes(v)) return fail(`expected one of ${schema.enum}`);
      if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return fail('expected YYYY-MM-DD');
      return [];
    case 'array': return Array.isArray(v) ? v.flatMap((x, i) => validate(schema.items, x, `${path}[${i}]`)) : fail('expected array');
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('expected object');
      const out = schema.required.filter((k) => !(k in v)).map((k) => `${path}.${k}: missing`);
      out.push(...Object.keys(v).filter((k) => !(k in schema.properties)).map((k) => `${path}.${k}: not in schema`));
      for (const [k, s] of Object.entries(schema.properties)) if (k in v) out.push(...validate(s, v[k], `${path}.${k}`));
      return out;
    }
    default: return [`${path}: unknown schema type ${schema.type}`];
  }
}

for (const [name, schema] of Object.entries(SCHEMAS)) {
  test(`${name} follows the structured-output schema rules`, () => {
    assert.deepEqual(lint(schema), []);
  });
}

test('requests use output_config.format and never force a tool', () => {
  const p = structuredParams({ model: 'claude-sonnet-5-5', systemBlocks: ['static', 'per-run'], content: 'hi', schema: MATCH_SCHEMA });
  assert.deepEqual(p.output_config, { format: { type: 'json_schema', schema: MATCH_SCHEMA } });
  assert.equal('tool_choice' in p, false);
  assert.equal('tools' in p, false);
  assert.ok(p.max_tokens >= 16000, 'thinking tokens count toward max_tokens');
  assert.deepEqual(p.system.map((b) => b.cache_control), [{ type: 'ephemeral' }, { type: 'ephemeral' }]);
});

test('structuredOutput reads the JSON after any thinking block', () => {
  const msg = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"matches":[]}' }] };
  assert.deepEqual(structuredOutput(msg), { matches: [] });
});

test('structuredOutput explains refusals, truncation, and non-JSON instead of returning garbage', () => {
  assert.throws(() => structuredOutput({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }), /declined \(cyber\)/);
  assert.throws(() => structuredOutput({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"mat' }] }), /max_tokens/);
  assert.throws(() => structuredOutput({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sure! Here you go' }] }), /not JSON/);
});

test('the mock returns what the schemas describe', () => {
  const page = mockFor({ messages: [{ role: 'user', content: transcribeUser({
    docName: 'Daily', pageIndex: 0, dateHint: '2026-10-17', typedText: '✓3', priorItems: [], imageB64: '',
  }) }] }, 'transcribe');
  assert.deepEqual(validate(RECORD_PAGE_SCHEMA, page), []);
  assert.equal(page.closes.length, 1, 'the typed ✓3 became a close');

  const dedupe = mockFor({ messages: [{ role: 'user', content: 'NEW n0: Call Tom\n\nOPEN 4: Call Tom' }] }, 'dedupe');
  assert.deepEqual(validate(MATCH_SCHEMA, dedupe), []);
  assert.deepEqual(dedupe.matches, [{ new_ref: 'n0', code: 4 }]);

  const plan = mockFor({ messages: [{ role: 'user', content: '#1 action: x\n#2 action: y' }] }, 'digest');
  assert.deepEqual(validate(DAILY_SCHEMA, plan), []);
});
