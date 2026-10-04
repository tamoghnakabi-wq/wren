// Live smoke test of the model adapters + loop against real models.
// Usage: VERCEL_OIDC_TOKEN=... npx tsx scripts/live-smoke.ts <source> <model>
import { createModelClient } from '../src/models/index';
import { runLoop, type RunStore, type ToolHost } from '../src/loop';
import { toolCatalog } from '../src/tools';
import { DEFAULT_TOOLS, type SessionEvent } from '../src/types';

const [source = 'platform', model = 'openai/gpt-5.6-luna'] = process.argv.slice(2);
const cred = source === 'local' ? '' : source === 'anthropic' ? process.env.ANTHROPIC_API_KEY! : process.env.VERCEL_OIDC_TOKEN!;
const events: SessionEvent[] = [];
let seq = 0;
const store: RunStore = {
  events: async () => structuredClone(events),
  append: async (type, data, status) => { const e = { id: `e${++seq}`, seq, runId: 'r', type, data: structuredClone(data), status } as SessionEvent; events.push(e); return e as never; },
  update: async (id, p) => { const e = events.find((x) => x.id === id)!; if (p.data !== undefined) e.data = structuredClone(p.data); if (p.status) e.status = p.status; },
  control: async () => ({ cancel: false, pause: false }),
  createApproval: async () => 'ap1',
  approvalState: async () => 'approved',
  recordUsage: async (u) => console.log('usage', u),
  notify: async (t, b) => console.log('NOTIFY', t, b),
  memory: { add: async () => 'm1', remove: async () => true },
};
const host: ToolHost = {
  runtime: 'cloud',
  async execute(name, args) {
    console.log('TOOL', name, JSON.stringify(args));
    if (name === 'computer.shell') return { output: 'exit 0\n' + (String(args.command).includes('date') ? 'Sat Oct  4 17:30:00 AEST 2026' : 'README.md\npackage.json\nsrc') };
    if (name === 'web.fetch') return { output: '# Example Domain\nThis domain is for use in illustrative examples in documents.' };
    return { output: 'ok' };
  },
};
events.push({ id: 'u1', seq: 0, runId: 'r', type: 'message', status: 'done', data: { role: 'user', text: 'Use the shell to list the files in /workspace, then fetch https://example.com, and tell me the page heading and the file count. Keep the final answer to one sentence.' } });
const t0 = Date.now();
const out = await runLoop({
  model: createModelClient({ source: source as never, credential: cred, baseUrl: 'http://127.0.0.1:1234/v1' }),
  modelName: model, source, instructions: 'You are a test agent. Use tools as asked.',
  tools: toolCatalog({ runtime: 'cloud', tools: DEFAULT_TOOLS, githubConnected: false }), hosted: [],
  runId: 'r', autonomy: 'balanced', store, host, deadline: Date.now() + 240000, step: 0, maxSteps: 8,
  log: (m, e) => console.log('LOG', m, JSON.stringify(e)),
});
console.log('OUTCOME', JSON.stringify(out), `${Date.now() - t0}ms`);
console.log('EVENTS', events.map((e) => `${e.type}:${e.status}`).join(' '));
