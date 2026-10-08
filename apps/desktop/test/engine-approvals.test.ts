import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
const { decide, finishEngine, startApprovalBridge, TimelineWriter } = await import('../src/engines/common');

// What an engine's permission prompt leaves on the step: a denial stays "Denied" when the engine then
// reports the refused call as an error, and the step keeps its risk and approval either way.
function fakeStore(answer: 'approved' | 'denied') {
  const rows = new Map<string, { status?: string; data?: Record<string, unknown> }>();
  let n = 0;
  return {
    rows,
    usageSource: '',
    async append(_type: string, data: Record<string, unknown>, status?: string) {
      const id = `ev${++n}`;
      rows.set(id, { status, data });
      return { id };
    },
    async update(id: string, patch: { status?: string; data?: Record<string, unknown> }) {
      const r = rows.get(id)!;
      if (patch.status) r.status = patch.status;
      if (patch.data) r.data = patch.data;
    },
    async createApproval() {
      return 'ap1';
    },
    async approvalState() {
      return answer;
    },
  };
}

const run = (store: unknown) => ({
  runId: 'r',
  store: store as never,
  agentName: 'a',
  autonomy: 'careful' as const,
  instructions: '',
  model: 'default',
  prompt: '',
  cwd: tmpdir(),
  folders: [tmpdir()],
  allow: { shell: true, browser: true, screen: true },
  signal: new AbortController().signal,
  saveResumeId: async () => {},
});
const call = { callId: 'toolu_1', name: 'computer.write_file', args: { path: `${tmpdir()}/a.txt` }, title: 'Write a.txt', paths: [`${tmpdir()}/a.txt`] };

describe('the approval bridge (W-129)', () => {
  const ask = (b: { url: string; token: string }, body: unknown, signal?: AbortSignal) =>
    fetch(b.url, { method: 'POST', headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });

  it('holds a place until the decision ends, and calls it off when the asker leaves', async () => {
    const seen: AbortSignal[] = [];
    let finish!: () => void;
    const settled = new Promise<void>((r) => (finish = r));
    const b = await startApprovalBridge(async ({ signal }) => {
      seen.push(signal);
      await settled; // a decision that is still waiting
      return { allow: true };
    });
    try {
      const leavers = Array.from({ length: 32 }, () => new AbortController());
      const pending = leavers.map((c) => ask(b, { tool_name: 'Bash', input: {} }, c.signal).catch(() => null));
      while (seen.length < 32) await new Promise((r) => setTimeout(r, 10));
      for (const c of leavers) c.abort();
      await Promise.all(pending);
      await new Promise((r) => setTimeout(r, 50));
      expect(seen.every((s) => s.aborted)).toBe(true); // every decision was called off
      // They are still deciding, so they still count: one more is refused.
      expect((await ask(b, { tool_name: 'Bash', input: {} })).status).toBe(429);
      finish();
      await new Promise((r) => setTimeout(r, 50));
      const r = await ask(b, { tool_name: 'Read', input: {} });
      expect(await r.json()).toEqual({ behavior: 'allow', updatedInput: {} });
    } finally {
      finish();
      b.close();
    }
  });

  it('drops a request still arriving when the bridge closes: it never reaches a decision (W-135)', async () => {
    const { request } = await import('node:http');
    let decided = 0;
    const b = await startApprovalBridge(async () => (decided++, { allow: true }));
    const u = new URL(b.url);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { authorization: `Bearer ${b.token}`, 'content-type': 'application/json', 'content-length': '40' } });
    req.on('error', () => {});
    const answer = new Promise<number | null>((r) => {
      req.on('response', (res) => r(res.statusCode ?? null));
      req.on('error', () => r(null));
      req.on('close', () => r(null));
    });
    req.write('{"tool_name":"Bash",'); // half the body
    await new Promise((r) => setTimeout(r, 100));
    b.close();
    req.end('"input":{}}            '); // the rest, after the close
    await answer;
    await new Promise((r) => setTimeout(r, 100));
    expect(decided).toBe(0);
  });

  it('refuses a body over 512 KB, a wrong token, and calls everything off when closed', async () => {
    let signal: AbortSignal | undefined;
    const b = await startApprovalBridge(async (r) => {
      signal = r.signal;
      await new Promise((res) => r.signal.addEventListener('abort', res));
      return { allow: true };
    });
    const big = await ask(b, { tool_name: 'Bash', input: { command: 'x'.repeat(600 * 1024) } }).catch(() => null);
    expect(big === null || big.status === 413).toBe(true);
    expect((await fetch(b.url, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })).status).toBe(403);
    const waiting = ask(b, { tool_name: 'Bash', input: {} }).catch(() => null);
    while (!signal) await new Promise((r) => setTimeout(r, 10));
    b.close();
    expect(signal.aborted).toBe(true);
    const r = await waiting;
    if (r) expect((await r.json()).behavior).toBe('deny');
  });
});

describe('after an engine turn', () => {
  it("says so when its processes can't be confirmed stopped, then only watches, never signalling again (W-126, W-130)", async () => {
    const { engines } = await import('../src/engines/common');
    vi.useFakeTimers();
    try {
      const notes: string[] = [];
      let stops = 0;
      let checks = 0;
      const p = {} as never;
      engines.add(p);
      // The first stop isn't confirmed; later, the group is gone.
      expect(await finishEngine(p, { status: async (t: string) => void notes.push(t) }, async () => (++stops, false), async () => ++checks < 3)).toBe(false);
      expect(notes[0]).toMatch(/couldn’t confirm that this engine’s processes stopped/);
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(15_000);
      expect(stops).toBe(1); // never signalled again
      expect(checks).toBe(3); // stopped watching once it was gone
      expect(engines.has(p)).toBe(false);

      // Someone else (quit, an update) confirmed the stop: the watch ends without checking.
      const q = {} as never;
      engines.add(q);
      checks = 0;
      await finishEngine(q, { status: async () => {} }, async () => false, async () => (++checks, true));
      engines.delete(q);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(checks).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('engine approvals on the timeline', () => {
  it('a stopped run allows nothing, even a call that needs no approval (W-122)', async () => {
    const store = fakeStore('approved');
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    const r = { ...run(store), autonomy: 'autonomous' as const, signal: AbortSignal.abort() };
    expect(await decide(r, writer, { callId: 'toolu_r', name: 'computer.read_file', args: { path: `${tmpdir()}/a.txt` }, title: 'Read a.txt', paths: [`${tmpdir()}/a.txt`] }, () => true)).toMatchObject({ allow: false });
  });

  it('a denied step stays denied after the engine reports it as an error', async () => {
    const store = fakeStore('denied');
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    expect(await decide(run(store), writer, call, () => true)).toMatchObject({ allow: false });
    await writer.toolEnd('toolu_1', 'The user denied this action. Do not retry it.', true);
    const step = [...store.rows.values()].find((r) => r.data?.name === 'computer.write_file')!;
    expect(step.status).toBe('denied');
    expect(step.data).toMatchObject({ risk: 'medium', approvalId: 'ap1', result: { output: 'Denied by the user.', isError: true } });
  });

  it('withdraws (denies) the approval when the asker leaves while it waits (W-129)', async () => {
    const store = { ...fakeStore('approved'), approvalState: async () => 'pending' as const, withdrawn: [] as string[], async withdrawApproval(id: string) { this.withdrawn.push(id); } };
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    const asker = new AbortController();
    setTimeout(() => asker.abort(), 100);
    expect(await decide(run(store), writer, call, () => true, asker.signal)).toMatchObject({ allow: false });
    expect(store.withdrawn).toEqual(['ap1']);
    expect([...store.rows.values()].find((r) => r.data?.name === 'computer.write_file')?.status).toBe('cancelled');
  });

  it("a sub-agent's permission prompt doesn't cut the message being written", async () => {
    const store = fakeStore('approved');
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    await writer.textDelta('The sub-agent has been laun');
    await decide(run(store), writer, { ...call, callId: 'toolu_sub' }, () => true); // unknown to the stream
    await writer.textDelta('ched in the background.');
    await writer.endMessage();
    const messages = [...store.rows.values()].filter((r) => r.data?.role === 'assistant');
    expect(messages.map((m) => m.data!.text)).toEqual(['The sub-agent has been launched in the background.']);
  });

  it("the agent's own call, prompted before the stream shows it, still ends the message there (W-132)", async () => {
    const store = fakeStore('approved');
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    await writer.textDelta('Let me write it.');
    await decide(run(store), writer, call, () => true); // the prompt arrives first
    await writer.toolStart(call.callId, call.name, call.args, call.title); // then the stream reports the call
    await writer.textDelta('Done.');
    await writer.endMessage();
    const messages = [...store.rows.values()].filter((r) => r.data?.role === 'assistant');
    expect(messages.map((m) => m.data!.text)).toEqual(['Let me write it.', 'Done.']);
  });

  it("takes over a generic engine step for the same call (Grok's stream says only 'write')", async () => {
    const store = fakeStore('approved');
    const writer = new TimelineWriter(store as never, 'grok-build', 'Grok Build');
    await writer.toolStart('call-1', 'grok.tool', {}, 'write');
    await decide(run(store), writer, { ...call, callId: 'call-1' }, () => true);
    await writer.toolEnd('call-1', 'ok', false);
    const steps = [...store.rows.values()].filter((r) => r.data?.name);
    expect(steps.map((r) => r.status)).toEqual(['done']); // one step, finished; no copy left running
  });

  it("a request naming another call's id doesn't take over that step (W-121)", async () => {
    const store = fakeStore('denied');
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    await writer.toolStart('toolu_read', 'computer.read_file', { path: 'a.txt' }, 'Read a.txt');
    await decide(run(store), writer, { ...call, callId: 'toolu_read' }, () => true);
    const steps = [...store.rows.values()].filter((r) => r.data?.name);
    expect(steps.map((r) => [r.data!.name, r.status])).toEqual([
      ['computer.read_file', 'running'], // untouched
      ['computer.write_file', 'denied'], // its own step
    ]);
  });

  it('an approved step keeps its risk and approval when it finishes', async () => {
    const store = fakeStore('approved');
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    expect(await decide(run(store), writer, call, () => true)).toMatchObject({ allow: true });
    await writer.toolEnd('toolu_1', 'File created', false);
    const step = [...store.rows.values()].find((r) => r.data?.name === 'computer.write_file')!;
    expect(step.status).toBe('done');
    expect(step.data).toMatchObject({ risk: 'medium', approvalId: 'ap1', result: { output: 'File created', isError: false } });
  });
});
