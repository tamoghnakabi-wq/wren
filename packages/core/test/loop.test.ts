import { describe, expect, it } from 'vitest';
import { MAX_MODEL_RETRIES, runLoop, type ApprovalState, type RunStore, type ToolContext, type ToolHost } from '../src/loop';
import { toolCatalog } from '../src/tools';
import { DEFAULT_TOOLS, ModelError, type ModelClient, type ModelRequest, type ModelTurn, type SessionEvent, type ToolCallData } from '../src/types';
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
  riskContext?: ToolHost['riskContext'];
  async execute(name: string, args: Record<string, unknown>, _ctx?: ToolContext) {
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

  it('does not repeat an action that was running when the worker died', async () => {
    const store = new MemStore();
    await store.userSays('push');
    const turn = await store.append('message', { role: 'assistant', text: '', raw: { format: 'responses', items: [] } }, 'done');
    // An approved push that crashed mid-flight, and a read that did the same.
    await store.append('tool', { callId: 'a', name: 'computer.shell', args: { command: 'git push' }, title: 'push', risk: 'high', turnId: turn.id, startedAt: 1 }, 'running');
    await store.append('tool', { callId: 'b', name: 'computer.read_file', args: { path: 'x' }, title: 'read', risk: 'low', turnId: turn.id, startedAt: 1 }, 'running');
    const model = new ScriptModel([{ text: 'Checked.' }]);
    const host = new FakeHost();
    const out = await base(store, model, host);
    expect(out.kind).toBe('completed');
    expect(host.ran).toEqual(['computer.read_file:{"path":"x"}']); // only the read is retried
    const push = store.events_.find((e) => (e.data as ToolCallData).callId === 'a')!;
    expect(push.status).toBe('error');
    expect((push.data as ToolCallData).result?.output).toMatch(/interrupted/);
  });

  it('does not repeat a low-risk cloud write after a crash', async () => {
    const store = new MemStore();
    await store.userSays('log it');
    const turn = await store.append('message', { role: 'assistant', text: '', raw: { format: 'responses', items: [] } }, 'done');
    // Low risk in the cloud (the VM is the agent's own), but appending twice is still a change.
    await store.append('tool', { callId: 'w', name: 'computer.shell', args: { command: 'printf x >> log.txt' }, title: 'append', risk: 'low', turnId: turn.id, startedAt: 1 }, 'running');
    const host = new FakeHost();
    const out = await base(store, new ScriptModel([{ text: 'Checked.' }]), host);
    expect(out.kind).toBe('completed');
    expect(host.ran).toEqual([]);
    expect(store.events_.find((e) => (e.data as ToolCallData).callId === 'w')!.status).toBe('error');
  });

  it('refuses an approved browser action when the element changed', async () => {
    const store = new MemStore();
    await store.userSays('send it');
    const model = new ScriptModel([{ calls: [{ name: 'browser.click', args: { ref: 'e5' } }] }, { text: 'The page changed; stopping.' }]);
    let label = 'Send message';
    const host = new FakeHost();
    host.riskContext = async () => ({ browserTarget: { label, role: 'button', elementId: 'd1-5', url: 'https://mail.test/to/alice' } });
    const first = await base(store, model, host);
    expect(first.kind).toBe('waiting_approval');
    const tool = store.events_.find((e) => e.type === 'tool')!;
    expect((tool.data as ToolCallData).target).toMatchObject({ label: 'Send message' });
    label = 'Place order'; // another run reused the browser while this waited
    store.approvals.set((tool.data as ToolCallData).approvalId!, 'approved');
    const out = await base(store, model, host);
    expect(out.kind).toBe('completed');
    expect(host.ran).toEqual([]);
    expect((store.events_.find((e) => e.type === 'tool')!.data as ToolCallData).result?.output).toMatch(/page changed/);
  });

  it('passes the assessed element to the browser', async () => {
    const store = new MemStore();
    await store.userSays('next page');
    const model = new ScriptModel([{ calls: [{ name: 'browser.click', args: { ref: 'e2' } }] }, { text: 'Done.' }]);
    const host = new FakeHost();
    host.riskContext = async () => ({ browserTarget: { label: 'Next page', role: 'link', elementId: 'd1-2', url: 'https://shop.test/p/1' } });
    let seen: unknown;
    host.execute = async (name, args, ctx) => {
      seen = ctx?.expect;
      host.ran.push(name);
      return { output: 'ok' };
    };
    await base(store, model, host, { autonomy: 'autonomous' });
    expect(seen).toMatchObject({ label: 'Next page', role: 'link', elementId: 'd1-2', url: 'https://shop.test/p/1' });
  });

  it('refuses an approved click on a same-labelled element elsewhere', async () => {
    const changes: Record<string, string>[] = [{ elementId: 'd2-5' }, { url: 'https://mail.test/to/bob' }, { href: '/evil' }];
    for (const changed of changes) {
      const store = new MemStore();
      await store.userSays('send it');
      const model = new ScriptModel([{ calls: [{ name: 'browser.click', args: { ref: 'e5' } }] }, { text: 'Stopping.' }]);
      let target: Record<string, string> = { label: 'Send', role: 'button', elementId: 'd1-5', url: 'https://mail.test/to/alice', href: '' };
      const host = new FakeHost();
      host.riskContext = async () => ({ browserTarget: target });
      expect((await base(store, model, host)).kind).toBe('waiting_approval');
      const tool = store.events_.find((e) => e.type === 'tool')!;
      target = { ...target, ...changed }; // e.g. another task moved the page to Bob's thread
      store.approvals.set((tool.data as ToolCallData).approvalId!, 'approved');
      await base(store, model, host);
      expect(host.ran, JSON.stringify(changed)).toEqual([]);
    }
  });

  it('does not ask approval for an element it cannot identify', async () => {
    const store = new MemStore();
    await store.userSays('click it');
    const model = new ScriptModel([{ calls: [{ name: 'browser.click', args: { ref: 'e9' } }] }, { text: 'I need a snapshot.' }]);
    const host = new FakeHost();
    host.riskContext = async () => ({});
    const out = await base(store, model, host);
    expect(out.kind).toBe('completed');
    expect(store.approvals.size).toBe(0);
    expect(host.ran).toEqual([]);
    expect((store.events_.find((e) => e.type === 'tool')!.data as ToolCallData).result?.output).toMatch(/Couldn't identify/);
  });

  it('re-creates tool calls a crash left unsaved', async () => {
    const store = new MemStore();
    await store.userSays('list');
    // The turn was stored with its calls, but the process died before the tool events were written.
    await store.append('message', { role: 'assistant', text: '', raw: { format: 'responses', items: [] }, calls: [{ callId: 'x1', namespace: 'computer', name: 'list_files', args: { path: '.' } }] }, 'done');
    const model = new ScriptModel([{ text: 'Listed.' }]);
    const host = new FakeHost();
    const out = await base(store, model, host);
    expect(out).toMatchObject({ kind: 'completed', result: 'Listed.' });
    expect(host.ran).toEqual(['computer.list_files:{"path":"."}']);
  });

  it('stops between actions of one turn when cancelled', async () => {
    const store = new MemStore();
    await store.userSays('two things');
    const model = new ScriptModel([{ calls: [{ name: 'web.fetch', args: { url: 'https://a.example' } }, { name: 'web.fetch', args: { url: 'https://b.example' } }] }]);
    const host = new FakeHost();
    host.execute = async (name, args) => {
      host.ran.push(`${name}:${JSON.stringify(args)}`);
      store.cancel = true; // the user presses Stop during the first action
      return { output: 'ok' };
    };
    const out = await base(store, model, host);
    expect(out.kind).toBe('cancelled');
    expect(host.ran).toHaveLength(1);
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

  it('retries a failing provider later, with a limit that survives across ticks', async () => {
    class Failing implements ModelClient {
      label = 'failing';
      async stream(): Promise<ModelTurn> {
        throw new ModelError('upstream overloaded', 503, 'overloaded', true);
      }
    }
    const store = new MemStore();
    await store.userSays('hello');
    const sleep = async () => {};
    const first = await base(store, new Failing(), new FakeHost(), { sleep });
    expect(first).toMatchObject({ kind: 'yield', retries: 1, wakeInMs: 60_000 });
    const third = await base(store, new Failing(), new FakeHost(), { sleep, modelRetries: 2 });
    expect(third).toMatchObject({ kind: 'yield', retries: 3, wakeInMs: 240_000 });
    const last = await base(store, new Failing(), new FakeHost(), { sleep, modelRetries: MAX_MODEL_RETRIES - 1 });
    expect(last.kind).toBe('failed');
    expect(last.kind === 'failed' && last.error).toMatch(/kept failing/);
  });
});
