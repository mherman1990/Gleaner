// A stand-in for the Anthropic Messages API. Tests point the real SDK at it with ANTHROPIC_BASE_URL, so the request
// Gleaner builds is the one the API would get. The test's handler returns each reply (an object becomes the JSON
// text of a structured-output response).
//
// Prompt caching is reported the way the API reports it. Each system block with cache_control ends a cacheable
// prefix. A prefix seen before is read from the cache; a new one is written. Prefixes under the 5.5 models'
// 512-token minimum (estimated at 4 characters a token) never cache.
import http from 'node:http';

const MIN_CACHE_TOKENS = 512;
const tokens = (s) => Math.ceil(s.length / 4);

/** Which Gleaner call a request is, from its system prompt. */
export function purposeOf(params) {
  const sys = params.system?.[0]?.text ?? '';
  if (sys.startsWith('You transcribe')) return 'transcribe';
  if (sys.startsWith('You match newly extracted')) return 'dedupe';
  if (sys.startsWith("You are Matt's morning")) return 'digest';
  if (sys.startsWith("You write Matt's Sunday")) return 'weekly';
  return 'unknown';
}

export async function fakeAnthropic(handler) {
  const requests = [];
  const seen = new Set();
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const params = JSON.parse(body || '{}');
    const purpose = purposeOf(params);
    requests.push({ path: req.url, purpose, params });

    let prefix = '', read = 0, write = 0;
    for (const block of params.system ?? []) {
      prefix += block.text;
      if (!block.cache_control || tokens(prefix) < MIN_CACHE_TOKENS) continue;
      const fresh = tokens(prefix) - read - write;
      if (seen.has(prefix)) read += fresh;
      else { seen.add(prefix); write += fresh; }
    }

    let reply;
    try { reply = await handler(params, purpose); }
    catch (e) { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      id: `msg_fake_${requests.length}`, type: 'message', role: 'assistant', model: params.model,
      content: [{ type: 'text', text: typeof reply === 'string' ? reply : JSON.stringify(reply) }],
      stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 200, output_tokens: 100, cache_read_input_tokens: read, cache_creation_input_tokens: write },
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}
