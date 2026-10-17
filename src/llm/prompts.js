// Prompts and response schemas. Everything static lives in cached system blocks; per-run context
// (the open-loop list) is a second cached block shared by every page in a batch.
//
// The schemas go to output_config.format (structured outputs), which accepts a subset of JSON Schema:
// every object needs additionalProperties: false; no min/max, minLength/maxLength, or maxItems constraints.
// Every property is required, and a field that may be absent is nullable (anyOf with null) instead of
// optional, so the shape the code reads never varies. test/llm.test.js checks these rules.
import { config } from '../config.js';

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const DATE = { type: 'string', format: 'date' };
const strings = { type: 'array', items: { type: 'string' } };
/** An object schema in the strict form structured outputs needs: closed, every property required. */
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const NOTATION = `
HANDWRITING NOTATION (the writer uses these conventions; they are the main signal for items)
- Date written in the top corner of the page (e.g. "10/16", "Thu 10/16", "Oct 16") = the page date.
- Empty box ☐ or [ ] at line start = an action the writer owns. Filled/checked box = that action is done.
- "→ Name: thing" = follow-up the writer owes Name (reach out, send, call).
- "← Name: thing" or "WF Name" = waiting on Name to deliver something.
- "DEC:" or a boxed "D" = a decision that was made.
- "?" circled, or "Q:" = an open question to resolve.
- "!" in the left margin = priority.
- "by Fri", "@10/22", "due 10/22", "EOW" = due date. Resolve relative dates against the page date.
- "#tag" or a circled word = project tag.
- Closing earlier items by their printed number (from the Today sheet):
    "✓14", "done 14", "14 ✓"   → close item 14 as done
    "x14", "✗14", "drop 14"    → close item 14 as dropped
    "14 → Fri", "snooze 14 Fri" → snooze item 14 until that date
- A struck-through line = the writer cancelled it; do not create an item for it.
`.trim();

export function transcribeSystem() {
  return `You transcribe handwritten pages from a reMarkable tablet for one person: Matt, an agriculture policy
executive who also farms. Pages are mostly meeting notes, call notes, daily plans, and running task lists.
Expect domain vocabulary: RFS, RVO, SRE, 45Z, CI score, GREET, ILUC, GTAP, FIFRA, PULA, EPA, USDA, Treasury,
farm bill, checkoff, ISA, ASA, USB, NBB/CFA, IRS, crop insurance, RMA, water quality, CRP, EQIP.

TRANSCRIPTION RULES
- Transcribe faithfully into clean Markdown. Keep the writer's structure (headings, bullets, indents, arrows).
- Do not correct the writer's claims or fill in content that is not on the page.
- Expand obvious shorthand only when unambiguous (e.g. "mtg" → "meeting"); otherwise keep it as written.
- For words you cannot read with confidence, write your best guess followed by [?], and list it in uncertain_spans.
- Diagrams/sketches: describe briefly in italics, e.g. *[sketch: flow from crusher → RD plant → CI score]*.
- Typed text (if provided separately) is exact; prefer it over your reading of the same words.

${NOTATION}

ITEM EXTRACTION RULES
- Extract an item only where the writer marked it with the notation above or wrote an explicit commitment
  ("I'll send...", "need to call..."). Do NOT turn ordinary notes, facts, or other people's statements into items.
  Fewer, accurate items beat many noisy ones.
- Write item text as a short imperative a reader understands out of context:
  "Send Tom the 45Z comment draft" — not "draft".
- person = the counterpart's name as written, or null. due = YYYY-MM-DD or null. priority = true only with "!".
- If an item matches one in "ITEMS PREVIOUSLY EXTRACTED FROM THIS PAGE", set existing_item_id to that id so it is
  updated, not duplicated; otherwise null.
- Use closes[] only for explicit number references ("✓14" etc.) or a checked box on a line matching an open item.
  snooze_until is the YYYY-MM-DD date for a snooze and null otherwise.
- tags: choose from this vocabulary when it fits; otherwise a short new kebab-case tag:
  ${config.tags.join(', ')}

Respond with the JSON object for this page.`;
}

export function openLoopsBlock(items) {
  if (!items.length) return 'OPEN ITEMS (by number): none.';
  const lines = items.map((i) => `${i.code}. ${i.text}${i.person ? ` [${i.person}]` : ''}${i.due ? ` (due ${i.due})` : ''}`);
  return `OPEN ITEMS (by number) — the writer may close or snooze these by number:\n${lines.join('\n')}`;
}

/** One handwritten page: its transcription and the items extracted from it. */
export const RECORD_PAGE_SCHEMA = object({
  page_date: { ...nullable(DATE), description: 'The date written on the page; null if none is written.' },
  summary: { type: 'string', description: 'One line, at most 20 words: what this page is about.' },
  tags: strings,
  transcription_md: { type: 'string' },
  legibility: { type: 'string', enum: ['high', 'medium', 'low'] },
  uncertain_spans: strings,
  items: {
    type: 'array',
    items: object({
      existing_item_id: nullable({ type: 'string' }),
      text: { type: 'string' },
      kind: { type: 'string', enum: ['action', 'followup', 'waiting', 'decision', 'idea', 'question'] },
      person: nullable({ type: 'string' }),
      due: nullable(DATE),
      priority: { type: 'boolean' },
      status: { type: 'string', enum: ['open', 'done', 'dropped'] },
      tags: strings,
    }),
  },
  closes: {
    type: 'array',
    items: object({
      code: { type: 'integer' },
      action: { type: 'string', enum: ['done', 'dropped', 'snooze'] },
      snooze_until: nullable(DATE),
      evidence: { type: 'string', description: 'The exact mark or words on the page.' },
    }),
  },
});

export function transcribeUser({ docName, pageIndex, dateHint, typedText, priorItems, imageB64 }) {
  const prior = priorItems.length
    ? priorItems.map((i) => `- id=${i.id}: ${i.text} [${i.status}]`).join('\n')
    : '- none';
  return [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } },
    {
      type: 'text',
      text: `Notebook: "${docName}", page ${pageIndex + 1}. If no date is written, the notebook was last modified ${dateHint}.
${typedText ? `Typed text on this page (exact):\n${typedText}\n` : ''}
ITEMS PREVIOUSLY EXTRACTED FROM THIS PAGE:
${prior}`,
    },
  ];
}

// ---- Cross-page dedupe (Haiku) -------------------------------------------------------------
export const DEDUPE_SYSTEM = `You match newly extracted to-do items against an existing open-item list.
A match means the SAME commitment rewritten (carried forward, reworded, or with a new date) — not merely the same topic
or the same person. When unsure, do not match. List only the matches: new_ref is the NEW item's label (e.g. "n0"),
code the OPEN item's number. An empty list is a valid answer.`;

/** Which new items are the same commitment as an existing open item. */
export const MATCH_SCHEMA = object({
  matches: { type: 'array', items: object({ new_ref: { type: 'string' }, code: { type: 'integer' } }) },
});

// ---- Daily plan (Sonnet) -------------------------------------------------------------------
export const DAILY_SYSTEM = `You are Matt's morning chief of staff, working ONLY from his handwritten-notes ledger.
Be direct and brief. Your job is to keep him on task: surface what is due, what is slipping, and what he keeps
rewriting without doing. Do not invent tasks or context. Calendar and email are handled elsewhere — do not
speculate about meetings. Refer to items by their number. top3 holds at most three items.`;

/** The morning plan. top3 is capped at three in code (structured outputs don't accept maxItems). */
export const DAILY_SCHEMA = object({
  headline: { type: 'string', description: 'One sentence: the shape of today.' },
  top3: { type: 'array', description: 'At most three items.', items: object({ code: { type: 'integer' }, why: { type: 'string' } }) },
  carrying_callout: { ...nullable({ type: 'string' }), description: 'If any item has been carried many days, one blunt sentence: do, delegate, or drop. Otherwise null.' },
  drop_candidates: { type: 'array', items: { type: 'integer' }, description: 'Stale items worth explicitly dropping.' },
});

// ---- Weekly review (Opus) ------------------------------------------------------------------
export const WEEKLY_SYSTEM = `You write Matt's Sunday weekly review from his handwritten-notes ledger: what he committed to,
what closed, what slipped, and the patterns in how his week actually went versus what he wrote down.
Be candid and specific; reference item numbers. No filler, no motivational language. Markdown, under 450 words,
with sections: Closed, Slipped, Patterns, Kill or recommit (stale loops), Next week's five.`;
