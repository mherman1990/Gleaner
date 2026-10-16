// Prompts and tool schemas. Everything static lives in cached system blocks; per-run context
// (the open-loop list) is a second cached block shared by every page in a batch.
import { config } from '../config.js';

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
- person = the counterpart's name as written. due = YYYY-MM-DD or null. priority = true only with "!".
- If an item matches one in "ITEMS PREVIOUSLY EXTRACTED FROM THIS PAGE", set existing_item_id so it is updated, not duplicated.
- Use closes[] only for explicit number references ("✓14" etc.) or a checked box on a line matching an open item.
- tags: choose from this vocabulary when it fits; otherwise a short new kebab-case tag:
  ${config.tags.join(', ')}

Always respond by calling record_page exactly once.`;
}

export function openLoopsBlock(items) {
  if (!items.length) return 'OPEN ITEMS (by number): none.';
  const lines = items.map((i) => `${i.code}. ${i.text}${i.person ? ` [${i.person}]` : ''}${i.due ? ` (due ${i.due})` : ''}`);
  return `OPEN ITEMS (by number) — the writer may close or snooze these by number:\n${lines.join('\n')}`;
}

export const RECORD_PAGE_TOOL = {
  name: 'record_page',
  description: 'Record the transcription and extracted items for one handwritten page.',
  input_schema: {
    type: 'object',
    properties: {
      page_date: { type: ['string', 'null'], description: 'YYYY-MM-DD from the written date; null if none written.' },
      summary: { type: 'string', description: 'One line, <= 20 words: what this page is about.' },
      tags: { type: 'array', items: { type: 'string' } },
      transcription_md: { type: 'string' },
      legibility: { type: 'string', enum: ['high', 'medium', 'low'] },
      uncertain_spans: { type: 'array', items: { type: 'string' } },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            existing_item_id: { type: ['string', 'null'] },
            text: { type: 'string' },
            kind: { type: 'string', enum: ['action', 'followup', 'waiting', 'decision', 'idea', 'question'] },
            person: { type: ['string', 'null'] },
            due: { type: ['string', 'null'] },
            priority: { type: 'boolean' },
            status: { type: 'string', enum: ['open', 'done', 'dropped'] },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['text', 'kind', 'status'],
        },
      },
      closes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            code: { type: 'integer' },
            action: { type: 'string', enum: ['done', 'dropped', 'snooze'] },
            snooze_until: { type: ['string', 'null'] },
            evidence: { type: 'string', description: 'The exact mark/words on the page.' },
          },
          required: ['code', 'action', 'evidence'],
        },
      },
    },
    required: ['summary', 'transcription_md', 'legibility', 'items', 'closes', 'tags'],
  },
};

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
or the same person. When unsure, do not match. Respond by calling match_items exactly once.`;

export const MATCH_TOOL = {
  name: 'match_items',
  description: 'Report which new items are the same commitment as an existing open item.',
  input_schema: {
    type: 'object',
    properties: {
      matches: { type: 'array', items: { type: 'object', properties: { new_ref: { type: 'string' }, code: { type: 'integer' } }, required: ['new_ref', 'code'] } },
    },
    required: ['matches'],
  },
};

// ---- Daily plan (Sonnet) -------------------------------------------------------------------
export const DAILY_SYSTEM = `You are Matt's morning chief of staff, working ONLY from his handwritten-notes ledger.
Be direct and brief. Your job is to keep him on task: surface what is due, what is slipping, and what he keeps
rewriting without doing. Do not invent tasks or context. Calendar and email are handled elsewhere — do not
speculate about meetings. Refer to items by their number. Respond by calling daily_plan exactly once.`;

export const DAILY_TOOL = {
  name: 'daily_plan',
  description: 'The morning plan.',
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'One sentence: the shape of today.' },
      top3: { type: 'array', maxItems: 3, items: { type: 'object', properties: { code: { type: 'integer' }, why: { type: 'string' } }, required: ['code', 'why'] } },
      carrying_callout: { type: ['string', 'null'], description: 'If any item has been carried many days, one blunt sentence: do, delegate, or drop.' },
      drop_candidates: { type: 'array', items: { type: 'integer' }, description: 'Stale items worth explicitly dropping.' },
    },
    required: ['headline', 'top3', 'drop_candidates'],
  },
};

// ---- Weekly review (Opus) ------------------------------------------------------------------
export const WEEKLY_SYSTEM = `You write Matt's Sunday weekly review from his handwritten-notes ledger: what he committed to,
what closed, what slipped, and the patterns in how his week actually went versus what he wrote down.
Be candid and specific; reference item numbers. No filler, no motivational language. Markdown, under 450 words,
with sections: Closed, Slipped, Patterns, Kill or recommit (stale loops), Next week's five.`;
