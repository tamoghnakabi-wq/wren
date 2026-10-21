import { Readable } from 'node:stream';
import { ModelError, type ModelRequest, type ModelTurn, type SessionEvent } from '@wren/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A cloud tick end to end (W-191): the real loop and cloud host, with stand-ins for the database, the run
// store, the model and the Vercel Sandbox. The tick looks for a Stop or a lost lease every 3 s (a fake
// interval here); what it finds must end a tool or model call that is waiting, through the loop's signal.

const RUN = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const MB = 1024 * 1024;
const CHUNK = 64 * 1024;

/** A file that streams 1 MB and then hangs until it's closed (a transfer that stalls). */
class StallingFile extends Readable {
  produced = 0;
  constructor() {
    super({ highWaterMark: 0 });
  }
  _read() {
    if (this.produced >= MB) return;
    this.produced += CHUNK;
    this.push(Buffer.alloc(CHUNK, 'a'));
  }
}

const box = {
  opened: [] as { stream: StallingFile; signal?: AbortSignal }[],
  async readFile(_file: { path: string }, opts?: { signal?: AbortSignal }) {
    const entry = { stream: new StallingFile(), signal: opts?.signal };
    box.opened.push(entry);
    return entry.stream;
  },
  async runCommand() {
    return { exitCode: 0, stdout: async () => '/vercel\n', logs: async function* () { yield { stream: 'stdout', data: '/vercel\n' }; } };
  },
  async writeFiles() {},
};
vi.mock('@vercel/sandbox', () => ({ Sandbox: { getOrCreate: async () => box } }));

// The database: the claim, the agent, and the tick's look at its lease (empty once another worker has it).
const state = {
  leaseHeld: true,
  cancel: false,
  events: [] as SessionEvent[],
  queries: [] as string[],
  finished: [] as { kind: string }[],
  kicked: 0,
};
const runRow = { id: RUN, agent_id: AGENT, user_id: 'user-1', session_id: 'session-1', model: { source: 'openai', model: 'test' }, step: 0, max_steps: 50, crash_count: 0, retry_count: 0 };
const agentRow = { id: AGENT, name: 'Agent', instructions: '', tools: {}, autonomy: 'autonomous', archived_at: null };
vi.mock('../src/lib/db', () => ({
  db: () => (strings: TemplateStringsArray) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    state.queries.push(text);
    if (text.startsWith('update public.runs set lease_id') && text.includes('returning *')) return Promise.resolve([runRow]);
    if (text.includes('from public.agents')) return Promise.resolve([agentRow]);
    if (text.includes('from public.profiles')) return Promise.resolve([{ email: 'user@example.test' }]);
    if (text.includes('from public.runs where id = ? and lease_id = ?')) return Promise.resolve(state.leaseHeld ? [{ x: 1 }] : []);
    return Promise.resolve([]);
  },
}));

// The run store keeps events in memory. Its writes are fenced by the lease, as the real one's are: once
// another worker holds the run, every write fails with LeaseLostError and changes nothing.
vi.mock('../src/lib/runner/store', () => {
  class LeaseLostError extends Error {
    status = 409;
    code = 'lease_lost';
  }
  const fence = () => {
    if (!state.leaseHeld) throw new LeaseLostError('This worker no longer holds this run.');
  };
  class DbRunStore {
    async events() {
      return state.events.map((e) => ({ ...e }));
    }
    async append(type: SessionEvent['type'], data: unknown, status?: string) {
      fence();
      const ev = { id: `e${state.events.length + 1}`, seq: state.events.length + 1, runId: RUN, type, status, data };
      state.events.push(ev);
      return ev;
    }
    async update(id: string, patch: { data?: unknown; status?: string }) {
      fence();
      const ev = state.events.find((e) => e.id === id);
      if (!ev) return;
      if (patch.data !== undefined) ev.data = patch.data;
      if (patch.status !== undefined) ev.status = patch.status;
    }
    async control() {
      return { cancel: state.cancel, pause: false };
    }
    async createApproval() {
      return 'approval-1';
    }
    async approvalState() {
      return 'pending';
    }
    async recordUsage() {}
    async notify() {}
    async live() {}
    memory = { add: async () => 'm', remove: async () => true };
  }
  return { DbRunStore, LeaseLostError };
});

// The model: its first turn is whatever the test sets; a turn that waits ends only through the signal.
const model = {
  signals: [] as (AbortSignal | undefined)[],
  turn: async (_req: ModelRequest): Promise<ModelTurn> => ({ text: 'done', toolCalls: [], raw: { format: 'responses', items: [] }, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, stopReason: 'end' }),
};
const client = {
  label: 'test',
  stream: (req: ModelRequest) => {
    model.signals.push(req.signal);
    const t = model.turn;
    model.turn = async () => ({ text: 'done', toolCalls: [], raw: { format: 'responses', items: [] }, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }, stopReason: 'end' });
    return t(req);
  },
};
vi.mock('../src/lib/models', () => ({
  resolveCloudModel: async () => ({ client, source: 'openai', model: 'test', webSearch: false }),
  connectionSecret: async () => null,
}));
vi.mock('../src/lib/runs', () => ({
  finishRun: async (_id: string, outcome: { kind: string }) => {
    state.finished.push(outcome);
    return 'paused';
  },
  kickTick: async () => {
    state.kicked++;
  },
}));
vi.mock('../src/lib/notify', () => ({ notifyUser: async () => {} }));
vi.mock('../src/lib/cleanup', () => ({ cleanUp: async () => {} }));
vi.mock('../src/lib/blob', () => ({ guessMime: () => 'application/octet-stream', saveArtifact: async () => ({}), readArtifactBytes: async () => null }));
vi.mock('../src/lib/env', () => ({ env: {} }));
vi.mock('../src/lib/mcp', () => ({ callMcp: async () => ({ output: '' }), mcpNamespace: (id: string) => `mcp_${id}`, mcpToolSpecs: () => [] }));
vi.mock('@wren/core/net', () => ({ fetchReadable: async () => ({ output: '', status: 200 }) }));

const { runTick } = await import('../src/lib/runner/tick');

const readCall = async (): Promise<ModelTurn> => ({
  text: '',
  toolCalls: [{ callId: 'call-1', namespace: 'computer', name: 'read_file', args: { path: 'slow.log' } }],
  raw: { format: 'responses', items: [] },
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
  stopReason: 'tool_calls',
});
/** A model call that ends only when its signal aborts, as a provider's stream does. */
const waitingTurn = (req: ModelRequest) =>
  new Promise<ModelTurn>((_, reject) => {
    if (!req.signal) return reject(new ModelError('The model call got no signal.', undefined, 'no_signal', false));
    req.signal.addEventListener('abort', () => reject(new ModelError('Request aborted.', undefined, 'aborted', false)), { once: true });
  });

const toolEvent = () => state.events.find((e) => e.type === 'tool');
/** Let pending work run until `ready()`. */
async function until(ready: () => boolean) {
  for (let i = 0; i < 500 && !ready(); i++) await new Promise((r) => setImmediate(r));
  expect(ready()).toBe(true);
}
const within = <T>(p: Promise<T>, ms = 2000) => Promise.race([p, new Promise<'still running'>((r) => setTimeout(() => r('still running'), ms))]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  box.opened = [];
  Object.assign(state, { leaseHeld: true, cancel: false, queries: [], finished: [], kicked: 0 });
  state.events = [{ id: 'e0', seq: 0, runId: RUN, type: 'message', status: 'done', data: { role: 'user', text: 'Read slow.log' } }];
  model.signals = [];
});
afterEach(() => vi.useRealTimers());

describe("a cloud tick's signal (W-191)", () => {
  it('a recorded Stop ends a file read that is waiting, and the run ends cancelled', async () => {
    model.turn = readCall;
    const tick = runTick(RUN);
    await until(() => (box.opened[0]?.stream.produced ?? 0) >= MB);
    expect(toolEvent()?.status).toBe('running');

    state.cancel = true; // the user pressed Stop
    await vi.advanceTimersByTimeAsync(3000);
    expect(await within(tick)).toBe('cancelled');
    expect(box.opened[0].stream.destroyed).toBe(true);
    expect(box.opened[0].signal?.aborted).toBe(true); // the read's request was ended too
    expect(toolEvent()).toMatchObject({ status: 'error', data: { result: { output: 'The task was stopped while reading /vercel/sandbox/slow.log.', isError: true } } });
    expect(model.signals[0]?.aborted).toBe(true); // the same signal the model calls get
    expect(state.finished).toEqual([{ kind: 'cancelled', steps: 1 }]);
  });

  it('a Stop during a model call ends the run cancelled, not failed', async () => {
    model.turn = waitingTurn;
    const tick = runTick(RUN);
    await until(() => model.signals.length === 1);
    state.cancel = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(await within(tick)).toBe('cancelled');
    expect(state.finished).toEqual([{ kind: 'cancelled', steps: 0 }]);
  });

  it('nothing ends while the run is wanted and held', async () => {
    model.turn = readCall;
    const tick = runTick(RUN);
    await until(() => (box.opened[0]?.stream.produced ?? 0) >= MB);
    await vi.advanceTimersByTimeAsync(9000);
    expect(await within(tick, 200)).toBe('still running');
    expect(box.opened[0].stream.destroyed).toBe(false);
    expect(state.queries.filter((q) => q.includes('from public.runs where id = ? and lease_id = ?'))).toHaveLength(3); // one look every 3 s
    state.cancel = true; // end it
    await vi.advanceTimersByTimeAsync(3000);
    expect(await within(tick)).toBe('cancelled');
  });

  it("a lost lease ends the tick without cancelling the run's calls or reporting anything", async () => {
    model.turn = readCall;
    const tick = runTick(RUN);
    await until(() => (box.opened[0]?.stream.produced ?? 0) >= MB);

    state.leaseHeld = false; // another worker took the run over
    await vi.advanceTimersByTimeAsync(3000);
    expect(await within(tick)).toBe('lease-lost');
    expect(box.opened[0].stream.destroyed).toBe(true); // this tick's own read ended
    // The call is left as it was for the worker that holds the run now; nothing was finished or handed on.
    expect(toolEvent()?.status).toBe('running');
    expect(state.events.some((e) => e.status === 'cancelled')).toBe(false);
    expect(state.finished).toEqual([]);
    expect(state.kicked).toBe(0);
    expect(state.queries.some((q) => q.includes('crash_count = ?') || q.includes('set step'))).toBe(false);
  });

  it('stops looking once the loop has ended', async () => {
    const tick = runTick(RUN); // the model answers at once
    expect(await within(tick)).toBe('completed');
    const looks = state.queries.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.queries.length).toBe(looks);
    expect(vi.getTimerCount()).toBe(0);
  });
});
