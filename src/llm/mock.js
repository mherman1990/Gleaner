// Deterministic stand-ins for each tool so the pipeline runs end-to-end without an API key.
import { localDate } from '../config.js';

const userText = (params) =>
  params.messages[0].content.filter?.((b) => b.type === 'text').map((b) => b.text).join('\n') ?? String(params.messages[0].content);

export function mockFor(params) {
  const tool = params.tool_choice?.name;
  const text = userText(params);

  if (tool === 'record_page') {
    const nb = text.match(/Notebook: "([^"]+)", page (\d+)/);
    const closes = [...text.matchAll(/✓(\d+)/g)].map((m) => ({ code: Number(m[1]), action: 'done', evidence: m[0] }));
    const prior = new Map([...text.matchAll(/id=(\S+): (.+) \[\w+\]$/gm)].map((m) => [m[2], m[1]]));
    const ex = (t) => prior.get(t) || null;
    return {
      page_date: localDate(),
      summary: `Mock notes from ${nb?.[1]} p${nb?.[2]}`,
      tags: ['45Z'],
      transcription_md: `## Mock transcription\n- notebook ${nb?.[1]}, page ${nb?.[2]}\n- ☐ Send Tom the 45Z comment draft`,
      legibility: 'high',
      uncertain_spans: [],
      items: [
        { existing_item_id: ex('Send Tom the 45Z comment draft'), text: 'Send Tom the 45Z comment draft', kind: 'followup', person: 'Tom', due: null, priority: true, status: 'open', tags: ['45Z'] },
        { existing_item_id: ex(`Review notes from ${nb?.[1]} p${nb?.[2]}`), text: `Review notes from ${nb?.[1]} p${nb?.[2]}`, kind: 'action', person: null, due: localDate(), priority: false, status: 'open', tags: [] },
      ],
      closes,
    };
  }
  if (tool === 'match_items') {
    const news = [...text.matchAll(/^NEW (\S+): (.+)$/gm)].map((m) => ({ ref: m[1], t: m[2].trim() }));
    const olds = [...text.matchAll(/^OPEN (\d+): (.+)$/gm)].map((m) => ({ code: Number(m[1]), t: m[2].trim() }));
    return { matches: news.flatMap((n) => olds.filter((o) => o.t === n.t).slice(0, 1).map((o) => ({ new_ref: n.ref, code: o.code }))) };
  }
  if (tool === 'daily_plan') {
    const codes = [...text.matchAll(/^#(\d+)/gm)].map((m) => Number(m[1])).slice(0, 3);
    return { headline: 'Mock plan: clear the follow-ups first.', top3: codes.map((c) => ({ code: c, why: 'mock' })), carrying_callout: null, drop_candidates: [] };
  }
  throw new Error(`mock: no handler for tool ${tool}`);
}
