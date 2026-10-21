import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The GitHub brokers after a Stop (W-194): the cloud host's github.request and the device route that the
// desktop forwards it to. An approved request must not go out once the task was stopped (or this worker
// lost the run), and a Stop that comes while it runs ends it.

const RUN = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const NOT_SENT = { output: 'The GitHub request was not sent because the task was stopped.', isError: true };

let leaseHeld = true;
let run: Record<string, unknown> = {};
let onSecret = () => {};
const queries: string[] = [];
vi.mock('../src/lib/db', () => ({
  db: () => (strings: TemplateStringsArray) => {
    const text = strings.join('?').replace(/\s+/g, ' ');
    queries.push(text);
    if (text.includes('from public.runs r join public.agents')) return Promise.resolve([{ ...run }]);
    return Promise.resolve(text.includes('lease_id') && !leaseHeld ? [] : [{ x: 1 }]);
  },
}));
vi.mock('../src/lib/cleanup', () => ({ cleanUp: async () => {} }));
vi.mock('../src/lib/blob', () => ({ guessMime: () => 'application/octet-stream', saveArtifact: async () => ({}), readArtifactBytes: async () => null }));
vi.mock('../src/lib/env', () => ({ env: {} }));
vi.mock('../src/lib/mcp', () => ({ callMcp: async () => ({ output: '' }), mcpNamespace: (id: string) => `mcp_${id}`, mcpToolSpecs: () => [] }));
vi.mock('@wren/core/net', () => ({ fetchReadable: async () => ({ output: '', status: 200 }) }));
vi.mock('@vercel/sandbox', () => ({ Sandbox: {} }));
vi.mock('../src/lib/auth', () => ({
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  },
  requireDevice: async () => ({ id: 'device-1', userId: 'user-1', name: 'Mac', platform: 'darwin' }),
}));
// Reading the GitHub sign-in takes a moment: the test can change the run meanwhile.
vi.mock('../src/lib/models', () => ({
  connectionSecret: async () => {
    onSecret();
    return { secret: 'not-a-real-token' };
  },
}));
vi.mock('../src/lib/platform-credits', () => ({ assertPlatformAllowed: () => {}, operatorGatewayToken: async () => '' }));
vi.mock('../src/lib/runs', () => ({ decideApproval: async () => ({}), finishRun: async () => 'ended', taskTx: async () => [] }));
vi.mock('../src/lib/runner/store', () => ({ DbRunStore: class {} }));
// The route imports through the app's '@/' alias, which vitest doesn't resolve: each is the module above.
vi.mock('@/lib/auth', () => import('../src/lib/auth'));
vi.mock('@/lib/blob', () => import('../src/lib/blob'));
vi.mock('@/lib/db', () => import('../src/lib/db'));
vi.mock('@/lib/http', () => import('../src/lib/http'));
vi.mock('@/lib/mcp', () => import('../src/lib/mcp'));
vi.mock('@/lib/models', () => import('../src/lib/models'));
vi.mock('@/lib/platform-credits', () => import('../src/lib/platform-credits'));
vi.mock('@/lib/runs', () => import('../src/lib/runs'));
vi.mock('@/lib/runner/store', () => import('../src/lib/runner/store'));

// GitHub itself: every request is recorded; `hold` keeps one open until its signal aborts.
const github = { sent: [] as { url: string; init: RequestInit }[], hold: false };
vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
  github.sent.push({ url, init });
  if (!github.hold) return Promise.resolve(new Response('{"number":1}', { status: 201 }));
  return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
});

const { SandboxHost } = await import('../src/lib/runner/sandbox-host');
const { POST } = (await import('../src/app/api/device/runs/[id]/[action]/route')) as unknown as { POST: (req: Request, ctx: { params: Promise<{ id: string; action: string }> }) => Promise<Response> };

async function until(ready: () => boolean) {
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(ready()).toBe(true);
}

beforeEach(() => {
  leaseHeld = true;
  run = { id: RUN, session_id: 's', agent_id: 'a', user_id: 'user-1', agent_name: 'A', model: { source: 'openai' }, lease_id: LEASE, status: 'running', cancel_requested: false };
  onSecret = () => {};
  queries.length = 0;
  github.sent = [];
  github.hold = false;
});
afterEach(() => {
  github.hold = false;
});

describe("the cloud host's github.request after a Stop (W-194)", () => {
  const request = { method: 'POST', path: '/repos/o/r/issues', body: { title: 'x' } };
  const host = () => new SandboxHost({ agentId: 'a', userId: 'u', sessionId: 's', runId: RUN, leaseId: LEASE, githubToken: 'not-a-real-token' });
  const ctx = (over: { signal?: AbortSignal; isCancelled?: () => Promise<boolean> } = {}) => ({
    runtime: 'cloud' as const,
    deadline: Date.now() + 200_000,
    callId: 'c',
    checkpoint: async () => {},
    isCancelled: async () => false,
    ...over,
  });

  it('sends nothing once Stop is recorded, the signal ended, or the tick lost the run', async () => {
    expect(await host().execute('github.request', request, ctx({ isCancelled: async () => true }))).toEqual(NOT_SENT);
    const stopped = new AbortController();
    stopped.abort();
    expect(await host().execute('github.request', request, ctx({ signal: stopped.signal }))).toEqual(NOT_SENT);
    leaseHeld = false;
    expect(await host().execute('github.request', request, ctx())).toEqual(NOT_SENT);
    expect(github.sent).toHaveLength(0);
  });

  it('sends a wanted request with the task signal, and a Stop while it runs ends it', async () => {
    const stop = new AbortController();
    const r = await host().execute('github.request', request, ctx({ signal: stop.signal }));
    expect(r).toEqual({ output: 'HTTP 201\n{\n "number": 1\n}', isError: false });
    expect(github.sent).toHaveLength(1);
    expect(github.sent[0].url).toBe('https://api.github.com/repos/o/r/issues');
    expect(github.sent[0].init.signal).toBe(stop.signal);

    github.hold = true;
    const p = host().execute('github.request', request, ctx({ signal: stop.signal }));
    await until(() => github.sent.length === 2);
    stop.abort();
    expect(await p).toEqual({ output: 'The task was stopped while the GitHub request was under way; GitHub may or may not have carried it out.', isError: true });
  });
});

describe("the device route's github requests after a Stop (W-194)", () => {
  const call = (signal?: AbortSignal) =>
    POST(
      new Request(`http://wren.test/api/device/runs/${RUN}/github`, {
        method: 'POST',
        headers: { authorization: 'Device not-a-real-token', 'x-wren-lease': LEASE, 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'POST', path: '/repos/o/r/issues', body: { title: 'x' } }),
        signal,
      }),
      { params: Promise.resolve({ id: RUN, action: 'github' }) },
    );

  it('sends nothing when Stop was requested', async () => {
    run = { ...run, cancel_requested: true };
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(NOT_SENT);
    // Also when the Stop is recorded, or the run ends, only while the sign-in is read.
    run = { ...run, cancel_requested: false };
    for (const now of [{ cancel_requested: true }, { status: 'cancelled' }]) {
      onSecret = () => (run = { ...run, ...now });
      expect(await (await call()).json()).toEqual(NOT_SENT);
      run = { ...run, cancel_requested: false, status: 'running' };
    }
    expect(github.sent).toHaveLength(0);
  });

  it('answers 409 and sends nothing when the lease is lost before the request goes out', async () => {
    onSecret = () => (run = { ...run, lease_id: '44444444-4444-4444-8444-444444444444' });
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'lease_lost' });
    expect(github.sent).toHaveLength(0);
  });

  it("sends nothing when the device's Stop aborted the request", async () => {
    const stop = new AbortController();
    onSecret = () => stop.abort();
    expect(await (await call(stop.signal)).json()).toEqual(NOT_SENT);
    expect(github.sent).toHaveLength(0);
  });

  it('sends a wanted request after reading the run again, with the request signal', async () => {
    const stop = new AbortController();
    const res = await call(stop.signal);
    expect(await res.json()).toEqual({ output: 'HTTP 201\n{"number":1}', isError: false });
    expect(github.sent).toHaveLength(1);
    const passed = github.sent[0].init.signal;
    expect(passed).toBeInstanceOf(AbortSignal);
    stop.abort();
    expect(passed?.aborted).toBe(true);
    expect(queries.filter((q) => q.includes('from public.runs r join public.agents'))).toHaveLength(2); // once to start, again before sending
  });
});
