import { describe, expect, it } from 'vitest';
import { runLoop, type ApprovalState, type RunStore, type ToolHost } from '../src/loop';
import { toolCatalog } from '../src/tools';
import { DEFAULT_TOOLS, type ModelClient, type ModelRequest, type ModelTurn, type SessionEvent, type ToolCallData } from '../src/types';
import { buildTurns } from '../src/transcript';

class MemStore implements RunStore {
  events_: SessionEvent[] = [];
  seq = 0;
  approvals = new Map<string, ApprovalState>();
  cancel = false;
  notes: string[] = [];
  mem = new Map<string, string>();
  constructor(public runId = 'run1') {}
  async events() {
    return this.events_.map((e) => ({ ...e, data: structuredClone(e.data) }));
  }
  async append<T>(type: SessionEvent['type'], data: T, status?: string) {
    const ev: SessionEvent<T> = { id: `ev${++this.seq}`, seq: this.seq, runId: this.runId, type, data: structuredClone(data), status };
    this.events_.push(ev as SessionEvent);
    return ev;
  }
  async update(id: string, patch: { data?: unknown; status?: string }) {
    const ev = this.events_.find((e) => e.id === id)!;
    if (patch.data !== undefined) ev.data = structuredClone(patch.data);
    if (patch.status !== undefined) ev.status = patch.status;
  }
  async control() {
    return { cancel: this.cancel, pause: false };
  }
  async createApproval() {
    const id = `ap${this.approvals.size + 1}`;
    this.approvals.set(id, 'pending');
    return id;
  }
  async approvalState(id: string) {
    return this.approvals.get(id) ?? 'denied';
  }
  async recordUsage() {}
  async notify(title: string) {
    this.notes.push(title);
  }
  memory = {
    add: async (f: string) => {
      const id = `m${this.mem.size + 1}`;
      this.mem.set(id, f);
      return id;
    },
    remove: async (id: string) => this.mem.delete(id),
  };
  userSays(text: string) {
    return this.append('message', { role: 'user', text }, 'done');
  }
}

/** Scripted model: each call returns the next turn. */
class ScriptModel implements ModelClient {
  label = 'script';
  calls: ModelRequest[] = [];
  constructor(private script: Array<Partial<ModelTurn> & { calls?: { name: string; args: Record<string, unknown> }[] }>) {}
  async stream(req: ModelRequest, on: (e: { type: 'text'; delta: string }) => void): Promise<ModelTurn> {
    this.calls.push(req);
    const s = this.script.shift();
    if (!s) throw new Error('script exhausted');
    if (s.text) on({ type: 'text', delta: s.text });
    const toolCalls = (s.calls ?? []).map((c, i) => {
      const [namespace, name] = c.name.split('.');
      return { callId: `c${this.calls.length}_${i}`, namespace, name, args: c.args };
    });
    return { text: s.text ?? '', toolCalls, raw: { format: 'responses', items: [] }, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 }, stopReason: toolCalls.length ? 'tool_calls' : 'end' };
  }
}

class FakeHost implements ToolHost {
  runtime = 'cloud' as const;
  ran: string[] = [];
  async execute(name: string, args: Record<string, unknown>) {
    this.ran.push(`${name}:${JSON.stringify(args)}`);
    return { output: `ok ${name}` };
  }
}

const tools = toolCatalog({ runtime: 'cloud', tools: DEFAULT_TOOLS, githubConnected: false });
const base = (store: MemStore, model: ModelClient, host: ToolHost, extra: Partial<Parameters<typeof runLoop>[0]> = {}) =>
  runLoop({
    model,
    modelName: 'test-model',
    source: 'openai',
    instructions: 'sys',
    tools,
    hosted: [],
    runId: store.runId,
    autonomy: 'balanced',
    store,
    host,
    deadline: Date.now() + 60_000,
    step: 0,
    maxSteps: 20,
    sleep: async () => {},
    ...extra,
  });

describe('agent loop', () => {
  it('runs tools then completes with the final answer', async () => {
    const store = new MemStore();
    await store.userSays('list files');
    const model = new ScriptModel([{ text: 'Looking', calls: [{ name: 'computer.list_files', args: { path: '/workspace' } }] }, { text: 'Done: 3 files' }]);
    const host = new FakeHost();
    const out = await base(store, model, host);
    expect(out).toMatchObject({ kind: 'completed', result: 'Done: 3 files', steps: 2 });
    expect(host.ran).toEqual(['computer.list_files:{"path":"/workspace"}']);
    // second model call saw the tool result
    const turns = buildTurns(model.calls[1].events);
    expect(turns[1]).toMatchObject({ kind: 'assistant', calls: [{ name: 'list_files', output: 'ok computer.list_files' }] });
  });

  it('pauses for approval on a high-risk call and resumes once approved', async () => {
    const store = new MemStore();
    await store.userSays('push it');
    const model = new ScriptModel([{ calls: [{ name: 'computer.shell', args: { command: 'git push origin main' } }] }, { text: 'Pushed.' }]);
    const host = new FakeHost();
    const first = await base(store, model, host);
    expect(first.kind).toBe('waiting_approval');
    expect(host.ran).toEqual([]);
    const tool = store.events_.find((e) => e.type === 'tool')!;
    expect(tool.status).toBe('awaiting_approval');
    expect((tool.data as ToolCallData).risk).toBe('high');

    // still pending -> stays waiting, no extra model calls
    const again = await base(store, model, host, { step: first.steps });
    expect(again.kind).toBe('waiting_approval');
    expect(model.calls.length).toBe(1);

    store.approvals.set((tool.data as ToolCallData).approvalId!, 'approved');
    const done = await base(store, model, host, { step: first.steps });
    expect(done).toMatchObject({ kind: 'completed', result: 'Pushed.' });
    expect(host.ran).toEqual(['computer.shell:{"command":"git push origin main"}']);
  });

  it('feeds a denial back to the model without running the tool', async () => {
    const store = new MemStore();
    await store.userSays('delete stuff');
    const model = new ScriptModel([{ calls: [{ name: 'computer.shell', args: { command: 'git reset --hard HEAD~3' } }] }, { text: 'Understood, not resetting.' }]);
    const host = new FakeHost();
    await base(store, model, host);
    const tool = store.events_.find((e) => e.type === 'tool')!;
    store.approvals.set((tool.data as ToolCallData).approvalId!, 'denied');
    const out = await base(store, model, host);
    expect(out.kind).toBe('completed');
    expect(host.ran).toEqual([]);
    expect(store.events_.find((e) => e.type === 'tool')!.status).toBe('denied');
    const turns = buildTurns(model.calls[1].events);
    expect((turns[1] as { calls: { output: string }[] }).calls[0].output).toMatch(/denied/);
  });

  it('blocks catastrophic commands outright', async () => {
    const store = new MemStore();
    await store.userSays('clean up');
    const model = new ScriptModel([{ calls: [{ name: 'computer.shell', args: { command: 'rm -rf /' } }] }, { text: 'Blocked, stopping.' }]);
    const host = new FakeHost();
    const out = await base(store, model, host, { autonomy: 'autonomous' });
    expect(out.kind).toBe('completed');
    expect(host.ran).toEqual([]);
    expect(store.events_.find((e) => e.type === 'tool')!.status).toBe('error');
  });

  it('asks the user and resumes with their answer', async () => {
    const store = new MemStore();
    await store.userSays('book something');
    const model = new ScriptModel([{ calls: [{ name: 'task.ask_user', args: { question: 'Which city?' } }] }, { text: 'Booking in Melbourne.' }]);
    const host = new FakeHost();
    const first = await base(store, model, host);
    expect(first).toMatchObject({ kind: 'waiting_input', question: 'Which city?' });
    expect(store.notes).toContain('Your agent has a question');
    await store.userSays('Melbourne');
    const out = await base(store, model, host);
    expect(out).toMatchObject({ kind: 'completed', result: 'Booking in Melbourne.' });
    const turns = buildTurns(model.calls[1].events);
    // the answer is delivered as the tool result, not as a duplicate user turn
    expect(turns.filter((t) => t.kind === 'user')).toHaveLength(1);
    expect((turns[1] as { calls: { output: string }[] }).calls[0].output).toBe('The user answered: Melbourne');
  });

  it('yields at the deadline and continues in the next tick', async () => {
    const store = new MemStore();
    await store.userSays('go');
    const model = new ScriptModel([{ calls: [{ name: 'web.fetch', args: { url: 'https://example.com' } }] }, { text: 'Fetched.' }]);
    const host = new FakeHost();
    const out1 = await base(store, model, host, { modelDeadline: Date.now() - 1 });
    expect(out1.kind).toBe('yield');
    expect(model.calls).toHaveLength(0);
    const out2 = await base(store, model, host);
    expect(out2).toMatchObject({ kind: 'completed', result: 'Fetched.' });
  });

  it('cancels open calls', async () => {
    const store = new MemStore();
    await store.userSays('push');
    const model = new ScriptModel([{ calls: [{ name: 'computer.shell', args: { command: 'git push' } }] }]);
    const host = new FakeHost();
    await base(store, model, host);
    store.cancel = true;
    const out = await base(store, model, host);
    expect(out.kind).toBe('cancelled');
    expect(store.events_.find((e) => e.type === 'tool')!.status).toBe('cancelled');
  });

  it('rejects unknown tools and bad arguments without executing', async () => {
    const store = new MemStore();
    await store.userSays('x');
    const model = new ScriptModel([{ calls: [{ name: 'nope.tool', args: {} }] }, { text: 'ok' }]);
    const host = new FakeHost();
    const out = await base(store, model, host);
    expect(out.kind).toBe('completed');
    expect(host.ran).toEqual([]);
  });

  it('handles memory and plan tools internally', async () => {
    const store = new MemStore();
    await store.userSays('remember I like tea');
    const model = new ScriptModel([
      { calls: [{ name: 'memory.remember', args: { fact: 'Likes tea' } }, { name: 'task.update_plan', args: { items: [{ text: 'a', status: 'done' }] } }] },
      { text: 'Noted.' },
    ]);
    const out = await base(store, model, new FakeHost());
    expect(out.kind).toBe('completed');
    expect([...store.mem.values()]).toEqual(['Likes tea']);
    expect(store.events_.some((e) => e.type === 'plan')).toBe(true);
  });
});
