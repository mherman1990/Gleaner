#!/usr/bin/env node
// Gleaner's local MCP server (v0.2 step 7). It runs on Matt's computer, started by the Claude app (installed as the
// gleaner.mcpb extension, or from claude_desktop_config.json), and turns each tool call into a call to the Gleaner
// API on the Pi, with its own token: GLEANER_URL (e.g. http://umbrel:3717 over Tailscale) and GLEANER_TOKEN. The Pi
// does the work and keeps the record; every change shows up in Gleaner's change log under the token's client name.
//
// MCP over stdio: one JSON-RPC message per line on stdin and stdout, written by hand so the server has no
// dependencies and runs on any Node 18+. Anything else goes to stderr.
import readline from 'node:readline';

export const VERSION = '1.0.0';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']; // newest first
const ITEM_FIELDS = ['code', 'text', 'kind', 'status', 'due', 'due_time', 'person', 'assignee', 'tags', 'priority', 'carry_days',
  'snooze_until', 'closed_at', 'closed_by', 'source', 'first_seen', 'last_seen'];

const base = () => {
  let url = (process.env.GLEANER_URL || '').trim().replace(/\/+$/, '').replace(/\/api$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url;
};

class ToolError extends Error {}

/** One call to the Gleaner API. Returns { status, body, headers }; throws a ToolError Claude can show as is. */
async function api(method, path, body) {
  const url = base();
  if (!url) throw new ToolError('Gleaner\'s address isn\'t set: put it in the extension\'s settings (GLEANER_URL), e.g. http://umbrel:3717');
  if (!process.env.GLEANER_TOKEN) throw new ToolError('No Gleaner token is set: create one on the Pi (token add …) and put it in the extension\'s settings (GLEANER_TOKEN)');
  let res;
  try {
    res = await fetch(url + path, {
      method,
      headers: { Authorization: `Bearer ${process.env.GLEANER_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(40000), // creates answer within 15 s, or as queued
    });
  } catch (e) {
    throw new ToolError(`Can't reach Gleaner at ${url} (${e.cause?.code || e.name || e.message}). Is this computer on Tailscale or the home network?`);
  }
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* markdown, or an error page */ }
  if (!res.ok) {
    const why = parsed?.error || String(text).slice(0, 200) || res.statusText;
    if (res.status === 401) throw new ToolError(`Gleaner didn't accept the token (401): ${why}`);
    if (res.status === 403) throw new ToolError(`This token isn't allowed to do that (403): ${why}`);
    if (res.status === 404) throw new ToolError(`Not found (404): ${why}`);
    throw new ToolError(`Gleaner answered ${res.status}: ${why}`);
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

const slim = (i) => Object.fromEntries(ITEM_FIELDS.filter((k) => k in i).map((k) => [k, i[k]]));
const query = (params) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  return q ? `?${q}` : '';
};

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' };
const CODE = { type: 'integer', minimum: 1, description: 'The item\'s number, as printed on the Today sheet (#14 → 14).' };
const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

/** The tools. Each answers with a JSON object (the result's structuredContent, and its text). */
export const TOOLS = [
  {
    name: 'list_items',
    title: 'List items',
    description: 'Items in Matt\'s task ledger (from his handwritten notes and other apps). Open items by default, which include '
      + 'snoozed ones whose date has come; "snoozed" lists those still hidden, "closed" the latest done and dropped, "all" the latest 500. '
      + 'Optionally only one project tag (aliases work).',
    inputSchema: { type: 'object', properties: {
      status: { type: 'string', enum: ['open', 'snoozed', 'closed', 'all'], description: 'Default: open.' },
      tag: { type: 'string', description: 'A project tag or one of its aliases.' },
    }, additionalProperties: false },
    annotations: READ,
    run: async ({ status, tag }) => ({ items: (await api('GET', `/api/items${query({ status, tag })}`)).body.map(slim) }),
  },
  {
    name: 'get_item',
    title: 'Get an item',
    description: 'One item by its number, with every field: which fields were edited by hand, close evidence, unregistered tags.',
    inputSchema: { type: 'object', properties: { code: CODE }, required: ['code'], additionalProperties: false },
    annotations: READ,
    run: async ({ code }) => ({ item: (await api('GET', `/api/items/${code}`)).body }),
  },
  {
    name: 'create_item',
    title: 'Add an item',
    description: 'Add a task to the ledger. It is checked against the open items first: if one is the same task, that item gets the '
      + 'details it lacked instead of a copy being added (result "merged"). The same source and source_ref sent again changes nothing '
      + '("existing"), even after that item is closed. "queued" means Gleaner is still working on it and the item will appear '
      + 'shortly. dry_run answers "existing", "would_create" or "would_merge" and changes nothing.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: 'A short imperative a reader understands out of context, e.g. "Send Jen the budget draft".' },
      due: DATE,
      due_time: { type: 'string', description: 'A time like 14:00 or 2pm. Without a due date it means today.' },
      person: { type: 'string', description: 'The person the task is about or with.' },
      assignee: { type: 'string', description: 'Who should do it, when not Matt.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Project tags.' },
      priority: { type: 'boolean' },
      kind: { type: 'string', enum: ['action', 'followup', 'waiting', 'decision', 'idea', 'question'] },
      source: { type: 'string', description: 'Where the task came from: a short lowercase name such as email or artifact. Default: api.' },
      source_ref: { type: 'string', description: 'That source\'s own id for it (an email\'s id), so sending it twice adds one item.' },
      dry_run: { type: 'boolean', description: 'Only say what would happen.' },
    }, required: ['text'], additionalProperties: false },
    annotations: { ...WRITE, idempotentHint: false },
    run: async ({ dry_run, ...item }) => {
      const { body } = await api('POST', `/api/items${dry_run ? '?dry_run=1' : ''}`, item);
      return { ...body, ...(body.item ? { item: slim(body.item) } : {}) };
    },
  },
  {
    name: 'update_item',
    title: 'Change an item',
    description: 'Close, drop, reopen or snooze an item, and/or edit its text, due date and time, person or assignee. status "done" '
      + 'ticks it off, "dropped" cancels it, "open" reopens it, "snoozed" hides it until the date in until. An edit wins over the '
      + 'handwritten page from then on. null or "" clears a field.',
    inputSchema: { type: 'object', properties: {
      code: CODE,
      status: { type: 'string', enum: ['done', 'dropped', 'open', 'snoozed'] },
      until: { ...DATE, description: 'For snoozed: the date it comes back, YYYY-MM-DD.' },
      note: { type: 'string', description: 'Why, kept with a close.' },
      text: { type: 'string' },
      due: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear it and its time.' },
      due_time: { type: ['string', 'null'], description: 'A time like 14:00 or 2pm, or null.' },
      person: { type: ['string', 'null'] },
      assignee: { type: ['string', 'null'], description: 'null means Matt.' },
    }, required: ['code'], additionalProperties: false },
    annotations: { ...WRITE, idempotentHint: true },
    run: async ({ code, ...change }) => {
      if (!Object.keys(change).length) throw new ToolError('Send a status and/or a field to change.');
      if (change.status === 'snoozed' && !change.until) throw new ToolError('A snooze needs until=YYYY-MM-DD.');
      return { item: slim((await api('POST', `/api/items/${code}`, change)).body) };
    },
  },
  {
    name: 'open_loops',
    title: 'Open loops',
    description: 'The open items as Gleaner\'s own markdown summary: overdue, due today, priority, waiting on others, the rest.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ,
    run: async () => ({ markdown: (await api('GET', '/api/open-loops.md')).body }),
  },
  {
    name: 'get_notes',
    title: 'Get notes',
    description: 'The transcribed handwritten notes for one day (date), or a range (from, to). With neither: the last three days.',
    inputSchema: { type: 'object', properties: { date: DATE, from: DATE, to: DATE }, additionalProperties: false },
    annotations: READ,
    run: async ({ date, from, to }) => {
      try {
        const { body } = await api('GET', date ? `/api/notes/${date}` : `/api/notes${query({ from, to })}`);
        return { markdown: typeof body === 'string' ? body : JSON.stringify(body) };
      } catch (e) {
        if (e instanceof ToolError && e.message.startsWith('Not found')) return { markdown: '', note: 'No notes for that day.' };
        throw e;
      }
    },
  },
  {
    name: 'search_notes',
    title: 'Search notes',
    description: 'Pages whose transcribed text contains the words, newest first (at most 50): date, notebook, page and summary.',
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'Words to look for.' } }, required: ['q'], additionalProperties: false },
    annotations: READ,
    run: async ({ q }) => ({ pages: (await api('GET', `/api/search${query({ q })}`)).body }),
  },
  {
    name: 'list_events',
    title: 'Recent changes',
    description: 'The ledger\'s change log, oldest first: who changed which item and how (handwriting, the browser, this token, …). '
      + 'since: today, YYYY-MM-DD or an ISO time (default: the last 24 hours); client: only one client\'s changes.',
    inputSchema: { type: 'object', properties: { since: { type: 'string' }, client: { type: 'string' } }, additionalProperties: false },
    annotations: READ,
    run: async ({ since, client }) => {
      const { body, headers } = await api('GET', `/api/events${query({ since, client })}`);
      return { events: body, more: headers.get('x-more') === 'true' };
    },
  },
];

const INSTRUCTIONS = 'Gleaner keeps Matt\'s task ledger, read from his handwritten reMarkable notes and added to by other apps. '
  + 'Items are referred to by their number (code), as printed on his Today sheet. Read with list_items, get_item, open_loops, '
  + 'get_notes and search_notes; change with update_item (done, dropped, open, snoozed, edits) and create_item. Every change '
  + 'is recorded under this connection\'s client name.';

/** Check arguments against a tool's schema, as far as these schemas go. Returns the first problem, or null. */
function invalid(tool, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  const { properties, required = [] } = tool.inputSchema;
  for (const k of required) if (args[k] === undefined) return `${k} is required`;
  for (const [k, v] of Object.entries(args)) {
    const p = properties[k];
    if (!p) return `unknown argument ${k}`;
    const types = [].concat(p.type);
    const ok = types.some((t) => (t === 'null' ? v === null : t === 'integer' ? Number.isInteger(v) : t === 'array' ? Array.isArray(v) : typeof v === t));
    if (!ok) return `${k} must be ${types.join(' or ')}`;
    if (p.enum && !p.enum.includes(v)) return `${k} must be one of ${p.enum.join(', ')}`;
    if (p.pattern && typeof v === 'string' && !new RegExp(p.pattern).test(v)) return `${k} must be ${p.description || p.pattern}`;
    if (p.minimum !== undefined && v < p.minimum) return `${k} must be at least ${p.minimum}`;
  }
  return null;
}

const result = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj });
const failure = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

/** Answer one JSON-RPC message. Returns the response, or null for a notification or a response. */
export async function handle(msg) {
  if (msg === null || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  const { id, method, params = {} } = msg;
  if (method === undefined || id === undefined) return null; // a notification (initialized, cancelled) or a client's response
  const reply = (r) => ({ jsonrpc: '2.0', id, result: r });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'gleaner', title: 'Gleaner', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return error(-32602, `Unknown tool: ${params.name}`);
      const args = params.arguments ?? {};
      const problem = invalid(tool, args);
      if (problem) return reply(failure(`Invalid arguments for ${tool.name}: ${problem}`));
      try {
        return reply(result(await tool.run(args)));
      } catch (e) {
        if (e instanceof ToolError) return reply(failure(e.message));
        process.stderr.write(`gleaner-mcp: ${tool.name} failed: ${e.stack || e}\n`);
        return reply(failure(`${tool.name} failed: ${e.message}`));
      }
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

/** Serve on stdin/stdout until stdin closes. */
export function serve(input = process.stdin, output = process.stdout) {
  const send = (m) => output.write(`${JSON.stringify(m)}\n`);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  lines.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    const answers = (await Promise.all([].concat(msg).map(handle))).filter(Boolean);
    if (answers.length) send(Array.isArray(msg) ? answers : answers[0]);
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.mjs')) serve();
