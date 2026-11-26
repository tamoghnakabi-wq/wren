import { describe, expect, it } from 'vitest';
import { deniedText, MAX_MODEL_RETRIES, runLoop, type ApprovalState, type RunStore, type ToolContext, type ToolHost } from '../src/loop';
import { toolCatalog } from '../src/tools';
import { assessCall, needsApproval } from '../src/policy';
import { checkPage, pageFileName } from '../src/pages';
import { DEFAULT_TOOLS, ModelError, PAGE_MAX_BYTES, type ModelClient, type ModelRequest, type ModelTurn, type SessionEvent, type ToolCallData } from '../src/types';
import { buildTurns, type NeutralTurn } from '../src/transcript';

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

  it('starts no approved action once Stop came while the approval was read or the call marked running (W-194)', async () => {
    // Stop recorded during one of the loop's own waits, after its checks at the top of the step.
    class StopDuring extends MemStore {
      constructor(public at: 'approval' | 'running') {
        super();
      }
      async approvalState(id: string) {
        const s = await super.approvalState(id);
        if (this.at === 'approval') this.cancel = true;
        return s;
      }
      async update(id: string, patch: { data?: unknown; status?: string }) {
        await super.update(id, patch);
        if (this.at === 'running' && patch.status === 'running') this.cancel = true;
      }
    }
    for (const runtime of ['cloud', 'desktop'] as const)
      for (const at of ['approval', 'running'] as const) {
        const store = new StopDuring(at);
        await store.userSays('make it public');
        const model = new ScriptModel([{ calls: [{ name: 'github.request', args: { method: 'PATCH', path: '/repos/audit/r', body: { private: false } } }] }, { text: 'Done.' }]);
        const host = Object.assign(new FakeHost(), { runtime });
        const opts = { autonomy: 'autonomous' as const, tools: toolCatalog({ runtime, tools: { ...DEFAULT_TOOLS, github: true }, githubConnected: true }) };
        const first = await base(store, model, host as ToolHost, opts);
        expect(first.kind).toBe('waiting_approval');
        store.approvals.set((store.events_.find((e) => e.type === 'tool')!.data as ToolCallData).approvalId!, 'approved');
        const out = await base(store, model, host as ToolHost, { ...opts, step: first.steps });
        expect(out.kind, `${runtime} ${at}`).toBe('cancelled');
        expect(host.ran, `${runtime} ${at}`).toEqual([]);
        expect(store.events_.find((e) => e.type === 'tool')!.status).toBe('cancelled');
      }
  });

  it('starts no action once the signal aborted while the last Stop check was still reading the store (W-194)', async () => {
    // The last look before the action: its read of the store is slow, the Stop (or a lost lease) aborts the
    // signal meanwhile, and the read then answers with what it saw before, no Stop.
    class SlowLastLook extends MemStore {
      armed = false;
      held?: () => void;
      constructor(private readonly signal: AbortSignal) {
        super();
      }
      async update(id: string, patch: { data?: unknown; status?: string }) {
        await super.update(id, patch);
        if (patch.status === 'running') this.armed = true; // the next read is the one right before the action
      }
      control() {
        if (!this.armed) return super.control();
        this.armed = false;
        return new Promise<{ cancel: boolean; pause: boolean }>((resolve) => {
          this.signal.addEventListener('abort', () => resolve({ cancel: false, pause: false }), { once: true });
          this.held?.();
        });
      }
    }
    for (const runtime of ['cloud', 'desktop'] as const) {
      const stop = new AbortController();
      const store = new SlowLastLook(stop.signal);
      const reading = new Promise<void>((r) => (store.held = r));
      await store.userSays('write the notes');
      const model = new ScriptModel([{ calls: [{ name: 'computer.write_file', args: { path: 'notes.txt', content: 'hi' } }] }, { text: 'Done.' }]);
      const host = Object.assign(new FakeHost(), { runtime });
      const opts = { autonomy: 'autonomous' as const, signal: stop.signal, tools: toolCatalog({ runtime, tools: DEFAULT_TOOLS, githubConnected: false }) };
      const out = base(store, model, host as ToolHost, opts);
      await reading;
      stop.abort();
      expect((await out).kind, runtime).toBe('cancelled');
      expect(host.ran, runtime).toEqual([]);
      expect(store.events_.find((e) => e.type === 'tool')!.status, runtime).toBe('cancelled');
    }
  });

  it('reports a notification or a saved memory cut off by a crash as interrupted, not done twice (W-195)', async () => {
    // The worker dies after the effect, before the call is recorded as done.
    class DiesOnce extends MemStore {
      dead = true;
      async update(id: string, patch: { data?: unknown; status?: string }) {
        const tool = this.events_.find((e) => e.id === id)?.type === 'tool';
        if (this.dead && tool && (patch.status === 'done' || patch.status === 'error')) throw new Error('worker died');
        return super.update(id, patch);
      }
    }
    for (const call of [{ name: 'task.notify', args: { title: 'Build finished', body: 'ok' } }, { name: 'memory.remember', args: { fact: 'The user prefers pnpm.' } }]) {
      const store = new DiesOnce();
      await store.userSays('go');
      const model = new ScriptModel([{ calls: [call] }, { text: 'Done.' }]);
      const host = new FakeHost();
      await base(store, model, host).catch(() => undefined); // the worker's run ends there, however it reports it
      expect(store.events_.find((e) => e.type === 'tool')!.status, call.name).toBe('running');
      store.dead = false; // started again
      const out = await base(store, model, host);
      expect(out.kind, call.name).toBe('completed');
      expect(store.notes.filter((n) => n === 'Build finished').length + store.mem.size, call.name).toBe(1);
      const tool = store.events_.find((e) => e.type === 'tool')!;
      expect(tool.status, call.name).toBe('error');
      expect(((tool.data as ToolCallData).result?.output ?? ''), call.name).toMatch(/interrupted/);
    }
    // Showing the plan again is harmless, so it still just runs.
    const store = new DiesOnce();
    await store.userSays('plan');
    const model = new ScriptModel([{ calls: [{ name: 'task.update_plan', args: { items: [{ text: 'a', status: 'pending' }] } }] }, { text: 'Done.' }]);
    await base(store, model, new FakeHost()).catch(() => undefined);
    store.dead = false;
    await base(store, model, new FakeHost());
    expect(store.events_.find((e) => e.type === 'tool')!.status).toBe('done');
  });

  it('asks before GitHub repository administration Wren has no list entry for, even when autonomous (W-188)', async () => {
    const calls = [
      { method: 'PUT', path: '/repos/audit/private-repo/actions/oidc/customization/sub', body: { use_default: false, include_claim_keys: ['repo', 'context'] } },
      { method: 'POST', path: '/repos/audit/private-repo/actions/runners/registration-token', body: {} },
      { method: 'PATCH', path: '/repos/audit/r/check-suites/preferences', body: { auto_trigger_checks: [{ app_id: 4, setting: false }] } },
    ];
    for (const runtime of ['cloud', 'desktop'] as const)
      for (const args of calls) {
        const store = new MemStore();
        await store.userSays('set up CI');
        const model = new ScriptModel([{ calls: [{ name: 'github.request', args }] }, { text: 'Done.' }]);
        const host = Object.assign(new FakeHost(), { runtime });
        const out = await base(store, model, host as ToolHost, { autonomy: 'autonomous', tools: toolCatalog({ runtime, tools: { ...DEFAULT_TOOLS, github: true }, githubConnected: true }) });
        expect(out.kind, `${runtime} ${args.path}`).toBe('waiting_approval');
        expect(host.ran, `${runtime} ${args.path}`).toEqual([]);
      }
  });

  it('asks before a GitHub change that would make a private repository public, even when autonomous (W-188)', async () => {
    for (const runtime of ['cloud', 'desktop'] as const) {
      const store = new MemStore();
      await store.userSays('tidy the repo');
      const model = new ScriptModel([{ calls: [{ name: 'github.request', args: { method: 'PATCH', path: '/repos/audit/private-repo', body: { private: false } } }] }, { text: 'Done.' }]);
      const host = Object.assign(new FakeHost(), { runtime });
      const out = await base(store, model, host as ToolHost, { autonomy: 'autonomous', tools: toolCatalog({ runtime, tools: { ...DEFAULT_TOOLS, github: true }, githubConnected: true }) });
      expect(out.kind, runtime).toBe('waiting_approval');
      expect(host.ran, runtime).toEqual([]);
      const tool = store.events_.find((e) => e.type === 'tool')!;
      expect((tool.data as ToolCallData).risk, runtime).toBe('critical');
    }
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

  it('tells the model what the user said when they denied with a reason', async () => {
    const store = new MemStore();
    await store.userSays('tidy the repo');
    const model = new ScriptModel([{ calls: [{ name: 'computer.shell', args: { command: 'git reset --hard HEAD~3' } }] }, { text: 'Using the branch instead.' }]);
    const host = new FakeHost();
    await base(store, model, host);
    const id = (store.events_.find((e) => e.type === 'tool')!.data as ToolCallData).approvalId!;
    store.approvals.set(id, 'denied');
    const asked: string[] = [];
    Object.assign(store, { approvalNote: async (a: string) => (asked.push(a), 'Not on main. Make a branch first.') });
    await base(store, model, host);
    expect(asked).toEqual([id]);
    expect(host.ran).toEqual([]);
    const output = (buildTurns(model.calls[1].events)[1] as { calls: { output: string }[] }).calls[0].output;
    expect(output).toContain('The user denied this action and said:\n\nNot on main. Make a branch first.');
    expect(output).toContain('take what they said into account');
  });

  it('gives an expired approval no reason, and a blank reason reads as none', async () => {
    expect(deniedText('   ')).toBe(deniedText());
    expect(deniedText('x'.repeat(900)).length).toBeLessThan(700);
    const store = new MemStore();
    await store.userSays('tidy the repo');
    const model = new ScriptModel([{ calls: [{ name: 'computer.shell', args: { command: 'git reset --hard HEAD~3' } }] }, { text: 'ok' }]);
    await base(store, model, new FakeHost());
    store.approvals.set((store.events_.find((e) => e.type === 'tool')!.data as ToolCallData).approvalId!, 'expired');
    let asked = 0;
    Object.assign(store, { approvalNote: async () => (asked++, 'never read') });
    await base(store, model, new FakeHost());
    expect(asked).toBe(0);
    expect((buildTurns(model.calls[1].events)[1] as { calls: { output: string }[] }).calls[0].output).toMatch(/expired/);
  });

  it('gives the model attached text files without saving their text', async () => {
    const store = new MemStore();
    await store.append('message', { role: 'user', text: 'Summarise this\n\n[Attached files: notes.txt]', attachments: [{ artifactId: 'a1', name: 'notes.txt', mime: 'text/plain', size: 11 }] }, 'done');
    const model = new ScriptModel([{ text: 'It says hello.' }]);
    const loads: string[] = [];
    await base(store, model, new FakeHost(), { loadAttachment: async (id) => (loads.push(id), new TextEncoder().encode('hello world')) });
    expect(loads).toEqual(['a1']);
    const turns = buildTurns(model.calls[0].events);
    expect(turns[0]).toMatchObject({ kind: 'user', text: expect.stringContaining('<attached-file name="notes.txt">\nhello world\n</attached-file>') });
    expect((store.events_[0].data as { text: string }).text).toBe('Summarise this\n\n[Attached files: notes.txt]');
  });

  it('ends cancelled when Stop comes while attached files load', async () => {
    const store = new MemStore();
    await store.append('message', { role: 'user', text: 'Read it', attachments: [{ artifactId: 'a1', name: 'notes.txt', mime: 'text/plain', size: 11 }] }, 'done');
    const ac = new AbortController();
    const model = new ScriptModel([{ text: 'never' }]);
    const out = await base(store, model, new FakeHost(), {
      signal: ac.signal,
      loadAttachment: async () => {
        ac.abort();
        throw new Error('aborted');
      },
    });
    expect(out.kind).toBe('cancelled');
    expect(model.calls).toHaveLength(0);
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

  it('gives the model the files and images sent with an answer', async () => {
    const store = new MemStore();
    await store.userSays('fix the error');
    const model = new ScriptModel([{ calls: [{ name: 'task.ask_user', args: { question: 'What does the log say?' } }] }, { text: 'It ran out of memory.' }, { text: 'Done.' }]);
    const host = new FakeHost();
    const load = async () => new TextEncoder().encode('FATAL: out of memory');
    expect(await base(store, model, host, { loadAttachment: load })).toMatchObject({ kind: 'waiting_input' });
    const image = { artifactId: 'img1', mime: 'image/png' };
    await store.append(
      'message',
      { role: 'user', text: 'Here\n\n[Attached files: app.log, shot.png]', images: [image], attachments: [{ artifactId: 'log1', name: 'app.log', mime: 'text/plain', size: 20 }, { artifactId: 'img1', name: 'shot.png', mime: 'image/png', size: 9 }] },
      'done',
    );
    await base(store, model, host, { loadAttachment: load });
    const ask = (turns: NeutralTurn[]) => (turns[1] as Extract<NeutralTurn, { kind: 'assistant' }>).calls[0];
    const call = ask(buildTurns(model.calls[1].events));
    expect(call.output).toContain('The user answered: Here');
    expect(call.output).toContain('<attached-file name="app.log">\nFATAL: out of memory\n</attached-file>');
    expect(call.images).toEqual([image]);
    expect(buildTurns(model.calls[1].events).filter((t) => t.kind === 'user')).toHaveLength(1);
    // Nothing is saved: the step keeps the answer as it was written.
    expect((store.events_.find((e) => e.type === 'tool')!.data as ToolCallData).result!.output).toBe('The user answered: Here\n\n[Attached files: app.log, shot.png]');
    // A later turn still gets them (the transcript is built again for each model call).
    await store.userSays('thanks');
    await base(store, model, host, { loadAttachment: load });
    expect(ask(buildTurns(model.calls[2].events)).images).toEqual([image]);
  });

  it('asks before setting a task for later, even for an autonomous agent', async () => {
    const store = new MemStore();
    const set: unknown[] = [];
    Object.assign(store, { schedule: async (req: unknown) => (set.push(req), { id: 'sch1', at: 'Thursday 5:00 pm (Australia/Melbourne)', name: 'Call the bank' }) });
    await store.userSays('remind me to call the bank at 5');
    const call = { name: 'task.schedule', args: { when: '2026-11-27T17:00:00+11:00', task: 'Remind the user to call the bank.', title: 'Call the bank' } };
    const model = new ScriptModel([{ calls: [call] }, { text: 'I’ll remind you at 5.' }]);
    const first = await base(store, model, new FakeHost(), { autonomy: 'autonomous' });
    expect(first.kind).toBe('waiting_approval');
    expect(set).toEqual([]);
    store.approvals.set('ap1', 'approved');
    expect(await base(store, model, new FakeHost(), { autonomy: 'autonomous' })).toMatchObject({ kind: 'completed' });
    expect(set).toEqual([{ when: call.args.when, task: call.args.task, title: 'Call the bank' }]);
    const step = store.events_.find((e) => e.type === 'tool')!.data as ToolCallData;
    expect(step.result).toMatchObject({ output: expect.stringContaining('“Call the bank” starts on its own at Thursday 5:00 pm'), meta: { schedule: 'sch1' } });
    expect(step.risk).toBe('high');
  });

  it('sets nothing for later when the user says no, and reports what the server refused', async () => {
    const store = new MemStore();
    const set: unknown[] = [];
    Object.assign(store, { schedule: async (req: unknown) => (set.push(req), { error: 'Pick a time at least a minute from now.' }) });
    await store.userSays('later');
    const call = { name: 'task.schedule', args: { when: '2026-11-27T17:00:00+11:00', task: 'Check the build.' } };
    const model = new ScriptModel([{ calls: [call] }, { text: 'OK.' }, { calls: [call] }, { text: 'Too soon.' }]);
    await base(store, model, new FakeHost());
    store.approvals.set('ap1', 'denied');
    await base(store, model, new FakeHost());
    expect(set).toEqual([]);
    await store.userSays('try again');
    await base(store, model, new FakeHost());
    store.approvals.set('ap2', 'approved');
    await base(store, model, new FakeHost());
    expect(set).toHaveLength(1);
    const steps = store.events_.filter((e) => e.type === 'tool').map((e) => (e.data as ToolCallData).result);
    expect(steps[0]).toMatchObject({ isError: true });
    expect(steps[1]).toMatchObject({ output: 'Pick a time at least a minute from now.', isError: true });
  });

  it('asks for a secret in a card and carries on when it is saved, declined or answered with a message', async () => {
    for (const answer of ['saved', 'declined', 'message'] as const) {
      const store = new MemStore();
      await store.userSays('run the payment tests');
      const call = { name: 'task.request_secret', args: { name: 'STRIPE_KEY', why: 'Your Stripe test key, for the tests.' } };
      const model = new ScriptModel([{ calls: [call] }, { text: 'Done.' }]);
      const first = await base(store, model, new FakeHost(), { autonomy: 'autonomous' });
      expect(first).toMatchObject({ kind: 'waiting_input', question: 'Needs a secret: STRIPE_KEY' });
      expect(store.notes).toContain('Your agent needs a secret');
      const step = store.events_.find((e) => e.type === 'tool')!;
      expect(step.status).toBe('awaiting_secret');
      // Nothing answered yet: it keeps waiting.
      expect(await base(store, model, new FakeHost())).toMatchObject({ kind: 'waiting_input' });
      if (answer === 'message') await store.userSays('skip that, use the mock');
      else step.data = { ...(step.data as object), secretAnswer: answer };
      const env: Record<string, string>[] = [];
      const host = Object.assign(new FakeHost(), { execute: async (_n: string, _a: unknown, ctx: { env?: Record<string, string> }) => (env.push(ctx.env ?? {}), { output: 'ok' }) });
      expect(await base(store, model, host, { secrets: answer === 'saved' ? [{ name: 'STRIPE_KEY', value: 'sk_test_123456' }] : [] })).toMatchObject({ kind: 'completed' });
      const result = (store.events_.find((e) => e.type === 'tool')!.data as ToolCallData).result!;
      if (answer === 'saved') expect(result).toMatchObject({ output: expect.stringContaining('$STRIPE_KEY') });
      else expect(result).toMatchObject({ isError: true, output: answer === 'declined' ? expect.stringContaining('declined') : expect.stringContaining('wrote a message instead') });
      expect(JSON.stringify(model.calls)).not.toContain('sk_test_123456');
    }
  });

  it('gives commands the task’s secrets, and refuses a name programs use', async () => {
    const store = new MemStore();
    await store.userSays('deploy');
    const model = new ScriptModel([{ calls: [{ name: 'computer.shell', args: { command: 'deploy' } }, { name: 'task.request_secret', args: { name: 'PATH', why: 'x' } }, { name: 'task.request_secret', args: { name: 'TOKEN', why: 'The deploy token.' } }] }, { text: 'Deployed.' }]);
    const env: Record<string, string>[] = [];
    const host = Object.assign(new FakeHost(), { execute: async (_n: string, _a: unknown, ctx: { env?: Record<string, string> }) => (env.push(ctx.env ?? {}), { output: 'ok' }) });
    const out = await base(store, model, host, { autonomy: 'autonomous', secrets: [{ name: 'TOKEN', value: 'tok_abcdef' }] });
    expect(out).toMatchObject({ kind: 'completed' });
    expect(env).toEqual([{ TOKEN: 'tok_abcdef' }]);
    const results = store.events_.filter((e) => e.type === 'tool').map((e) => (e.data as ToolCallData).result);
    expect(results[1]).toMatchObject({ isError: true, output: expect.stringContaining('something else') });
    // Already saved for this task: no card, the agent is told it has it.
    expect(results[2]).toMatchObject({ output: expect.stringContaining('$TOKEN') });
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

  it("asks before pressing Playwright's Enter aliases on a purchase button, as for Enter (W-165)", async () => {
    for (const key of ['Enter', '\n', '\r', 'Shift+\n']) {
      const store = new MemStore();
      await store.userSays('buy it');
      const model = new ScriptModel([{ calls: [{ name: 'browser.press', args: { key } }] }, { text: 'Waiting.' }]);
      const host = new FakeHost();
      host.riskContext = async () => ({ browserTarget: { label: 'Place order', role: 'button', elementId: 'd1-7', url: 'https://shop.test/checkout' } });
      const out = await base(store, model, host, { autonomy: 'autonomous' });
      expect(out.kind, JSON.stringify(key)).toBe('waiting_approval');
      expect(host.ran, JSON.stringify(key)).toEqual([]);
      expect((store.events_.find((e) => e.type === 'tool')!.data as ToolCallData).risk, JSON.stringify(key)).toBe('critical');
    }
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

describe('usage limits (resume after the reset)', () => {
  class Limited implements ModelClient {
    label = 'limited';
    constructor(private resetAt?: number) {}
    async stream(): Promise<ModelTurn> {
      const e = new ModelError('You have hit your usage limit.', 429, 'usage_limit_reached', false);
      if (this.resetAt) e.resetAt = this.resetAt;
      throw e;
    }
  }

  it("pauses with the limit and its reset instead of failing", async () => {
    const store = new MemStore();
    await store.userSays('hello');
    const out = await base(store, new Limited(1_900_000_000_000), new FakeHost());
    expect(out).toMatchObject({ kind: 'paused', limit: { code: 'usage_limit_reached', resetAt: 1_900_000_000_000, midTurn: false } });
    expect(out.kind === 'paused' && out.limit?.error).toMatch(/usage limit/);
  });

  it('says the turn was cut short when steps were done in this tick', async () => {
    const store = new MemStore();
    await store.userSays('list files');
    let n = 0;
    const model: ModelClient = {
      label: 'then-limited',
      async stream(req, on) {
        if (n++ === 0) return new ScriptModel([{ calls: [{ name: 'computer.list_files', args: { path: '/workspace' } }] }]).stream(req, on);
        throw new ModelError('limit', 429, 'subscription_sharing_usage_limit_exceeded', false);
      },
    };
    const out = await base(store, model, new FakeHost());
    expect(out).toMatchObject({ kind: 'paused', limit: { midTurn: true } });
    expect(out.kind === 'paused' && out.limit?.resetAt).toBeUndefined();
  });

  it('still fails on other errors that are not retried', async () => {
    const store = new MemStore();
    await store.userSays('hello');
    const model: ModelClient = {
      label: 'bad',
      async stream() {
        throw new ModelError('bad key', 401, 'invalid_api_key', false);
      },
    };
    expect((await base(store, model, new FakeHost())).kind).toBe('failed');
  });
});

describe('task.show_page', () => {
  class PageStore extends MemStore {
    pages: { title: string; html: string }[] = [];
    async savePage(p: { title: string; html: string }) {
      this.pages.push(p);
      return { id: '11111111-2222-3333-4444-555555555555', name: `${p.title}.html` };
    }
  }

  it('keeps the page as a file and the step only its size', async () => {
    const store = new PageStore();
    await store.userSays('chart it');
    const html = `<!doctype html><title>x</title><body>${'<p>row</p>'.repeat(300)}</body>`;
    const model = new ScriptModel([{ calls: [{ name: 'task.show_page', args: { title: '  Sales\nby month ', html } }] }, { text: 'Here it is.' }]);
    const host = new FakeHost();
    const out = await base(store, model, host);
    expect(out.kind).toBe('completed');
    expect(host.ran).toEqual([]); // a built-in: never sent to the computer
    expect(store.pages).toEqual([{ title: 'Sales by month', html }]);
    const step = store.events_.find((e) => e.type === 'tool')!;
    const d = step.data as ToolCallData;
    expect(step.status).toBe('done');
    expect(d.result).toMatchObject({ artifacts: [{ id: '11111111-2222-3333-4444-555555555555' }], meta: { page: '11111111-2222-3333-4444-555555555555' } });
    expect(String(d.args.html)).toMatch(/^\[3 KB of HTML, shown as page 1111/);
    expect(JSON.stringify(d)).not.toContain('<p>row</p>');
  });

  it('refuses an empty or oversized page, and says why', async () => {
    for (const [html, why] of [
      ['   ', /empty/],
      ['x'.repeat(PAGE_MAX_BYTES + 1), /at most 512 KB/],
    ] as const) {
      const store = new PageStore();
      await store.userSays('show');
      const model = new ScriptModel([{ calls: [{ name: 'task.show_page', args: { title: 't', html } }] }, { text: 'ok' }]);
      await base(store, model, new FakeHost());
      const step = store.events_.find((e) => e.type === 'tool')!;
      expect(step.status).toBe('error');
      expect((step.data as ToolCallData).result?.output).toMatch(why);
      expect(store.pages).toEqual([]);
    }
  });

  it('tells the agent when the store keeps no pages', async () => {
    const store = new MemStore();
    await store.userSays('show');
    const model = new ScriptModel([{ calls: [{ name: 'task.show_page', args: { title: 't', html: '<p>hi</p>' } }] }, { text: 'ok' }]);
    await base(store, model, new FakeHost());
    expect((store.events_.find((e) => e.type === 'tool')!.data as ToolCallData).result?.output).toMatch(/can’t be shown here/);
  });

  it('is offered to every agent and needs no approval', () => {
    const t = toolCatalog({ runtime: 'cloud', tools: { ...DEFAULT_TOOLS, computer: false, browser: false, web: false, memory: false, notify: false }, githubConnected: false });
    expect(t.some((x) => x.namespace === 'task' && x.name === 'show_page')).toBe(true);
    const risk = assessCall('task.show_page', { title: 't', html: '<p>' }, 'cloud', {}).risk;
    expect(risk).toBe('low');
    expect(needsApproval(risk, 'careful')).toBe(false);
  });

  it('names its file after the title', () => {
    expect(pageFileName('Q3: sales / costs?')).toBe('Q3 sales costs.html');
    expect(pageFileName('***')).toBe('page.html');
    expect(checkPage({ html: '<p>' })).toEqual({ title: 'Page', html: '<p>' });
  });
});
