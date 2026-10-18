// Prompts and response schemas. Everything static lives in cached system blocks; per-run context
// (the open-loop list) is a second cached block shared by every page in a batch.
//
// The schemas go to output_config.format (structured outputs), which accepts a subset of JSON Schema:
// every object needs additionalProperties: false; no min/max, minLength/maxLength, or maxItems constraints.
// Every property is required, and a field that may be absent is nullable (anyOf with null) instead of
// optional, so the shape the code reads never varies. test/llm.test.js checks these rules.
import { config } from '../config.js';
import { currentRegistry, promptBlock } from '../registry.js';

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
- A time on an item line ("2pm", "@2:30", "Fri 3pm", "by 10am") = due time. A time with no date means the page date.
- "@Name" on an item line (a name, not a date or time), "Name to …", or "owner: Name" = the item is assigned to Name.
- "#tag" or a circled word = project tag.
- Closing earlier items by their printed number (from the Today sheet):
    "✓14", "done 14", "14 ✓"   → close item 14 as done
    "x14", "✗14", "drop 14"    → close item 14 as dropped
    "14 → Fri", "snooze 14 Fri" → snooze item 14 until that date
- A struck-through line = the writer cancelled it; do not create an item for it.
`.trim();

/** The static system prompt. It changes only with the registry file, so prompt caching keeps working. */
export function transcribeSystem(r = currentRegistry()) {
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
- Exception: when the page text says the notebook is a TASK LIST, every written line that reads as something to do
  is an item (kind "action" unless the notation says otherwise), even with no box, arrow, or date. Headings, dates,
  and crossed-out lines are still not items, and a ticked line is an item with status "done". Keep the writer's
  wording for these; add a verb only when the meaning is unmistakable.
- Write item text as a short imperative a reader understands out of context:
  "Send Tom the 45Z comment draft" — not "draft".
- person = the counterpart's name as written, or null. assignee = the name the item is assigned to, or null when the
  writer owns it (the usual case). due = YYYY-MM-DD or null. due_time = HH:MM on a 24-hour clock ("14:00") when a
  time is written for the item, else null. priority = true only with "!".
- If an item matches one in "ITEMS PREVIOUSLY EXTRACTED FROM THIS PAGE", set existing_item_id to that id so it is
  updated, not duplicated; otherwise null.
- Use closes[] only for explicit number references ("✓14" etc.) or a checked box on a line matching an open item.
  snooze_until is the YYYY-MM-DD date for a snooze and null otherwise.
${r ? REGISTRY_RULES : `- tags: choose from this vocabulary when it fits; otherwise a short new kebab-case tag:
  ${config.tags.join(', ')}`}
${r ? `\n${promptBlock(r)}\n` : ''}
Respond with the JSON object for this page.`;
}

// With a registry: map tags and names onto it. Unknown tags and names are kept as written; code re-checks both.
const REGISTRY_RULES = `- tags (page and item): use the canonical tag from PROJECT TAGS, mapping any alias or variant to it, or a
  CONTEXT TAG. Tag only what the page marks (#tag, a circled word) or what plainly belongs to a listed project.
  A #tag or circled word that matches nothing listed: keep it exactly as written.
- person and assignee: when a name matches a form under PEOPLE, write that person's full name. A bare first name
  that fits more than one listed person stays exactly as written: never guess which one is meant.`;

export function openLoopsBlock(items) {
  if (!items.length) return 'OPEN ITEMS (by number): none.';
  const lines = items.map((i) => `${i.code}. ${i.text}${i.person ? ` [${i.person}]` : ''}${i.assignee ? ` @${i.assignee}` : ''}` +
    `${i.due ? ` (due ${i.due}${i.due_time ? ` ${i.due_time}` : ''})` : ''}`);
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
      assignee: nullable({ type: 'string' }),
      due: nullable(DATE),
      due_time: { ...nullable({ type: 'string' }), description: 'HH:MM, 24-hour clock.' },
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

export function transcribeUser({ docName, pageIndex, dateHint, typedText, priorItems, closedItems = [], imageB64, taskList = false }) {
  const list = (items) => items.map((i) => `- id=${i.id}: ${i.text} [${i.status}]`).join('\n');
  const prior = priorItems.length ? list(priorItems) : '- none';
  // Items from other pages that this one closed or snoozed: so a ticked line for one is linked, not read as new.
  const closed = closedItems.length ? `\nITEMS THIS PAGE CLOSED OR SNOOZED, by number or by a ticked line (they are not new items):
${list(closedItems)}
A ticked line that is one of these: set existing_item_id to its id.` : '';
  return [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } },
    {
      type: 'text',
      text: `Notebook: "${docName}", page ${pageIndex + 1}. If no date is written, the notebook was last modified ${dateHint}.
${taskList ? 'This notebook is a TASK LIST: every written line that reads as something to do is an item.\n' : ''}${typedText ? `Typed text on this page (exact):\n${typedText}\n` : ''}
ITEMS PREVIOUSLY EXTRACTED FROM THIS PAGE:
${prior}${closed}`,
    },
  ];
}

// ---- Cross-page dedupe (Haiku) -------------------------------------------------------------
export const DEDUPE_SYSTEM = `You match newly extracted to-do items against existing items. NEW items were just read from a page;
"(ticked)" means the line is ticked off there. OPEN items are open or snoozed; CLOSED items are done or dropped ones
from the same page.
A match means the SAME commitment rewritten (carried forward, reworded, ticked off, or with a new date) — not merely
the same topic or the same person. A ticked NEW item may match an OPEN or a CLOSED one; one that isn't ticked never
matches a CLOSED one (writing a done task again is a new commitment). When unsure, do not match. List only the
matches: new_ref is the NEW item's label (e.g. "n0"), code the existing item's number. An empty list is a valid answer.`;

/** Which new items are the same commitment as an existing open item. */
export const MATCH_SCHEMA = object({
  matches: { type: 'array', items: object({ new_ref: { type: 'string' }, code: { type: 'integer' } }) },
});

// ---- Daily plan (Sonnet) -------------------------------------------------------------------
export const DAILY_SYSTEM = `You are Matt's morning chief of staff, working ONLY from his handwritten-notes ledger.
Be direct and brief. Your job is to keep him on task: surface what is due, what is slipping, and what he keeps
rewriting without doing. Do not invent tasks or context. Calendar and email are handled elsewhere — do not
speculate about meetings. Refer to items by their number. top3 holds at most three items.
An item with assigned=Name is delegated: Name does it and Matt only follows up, so it belongs in top3 only when it is
due or overdue and needs chasing. A due time (due=2026-10-20 14:00) is a deadline at that time of day.`;

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
