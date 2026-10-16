import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// An MCP SDK stand-in. Its connect() takes as long as the test wants (a slow server) and, like the
// auditor's, ignores the signal it is given, so only Wren's own checks stand between a Stop and the call.
const sdk = {
  hold: true,
  connects: [] as { signal?: AbortSignal }[],
  calls: [] as { params: unknown; options?: { signal?: AbortSignal } }[],
  closed: 0,
  release: () => {},
  callTool: (async () => ({ content: [{ type: 'text', text: 'sent' }] })) as (options?: { signal?: AbortSignal }) => Promise<unknown>,
};
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect(_transport: unknown, options?: { signal?: AbortSignal }) {
      sdk.connects.push(options ?? {});
      return sdk.hold ? new Promise<void>((r) => (sdk.release = r)) : Promise.resolve();
    }
    callTool(params: unknown, _schema?: unknown, options?: { signal?: AbortSignal }) {
      sdk.calls.push({ params, options });
      return sdk.callTool(options);
    }
    async close() {
      sdk.closed++;
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }));
vi.mock('@wren/core/net', () => ({ assertPublicUrl: async (u: string) => new URL(u), guardedFetch: fetch, fetchReadable: async () => ({ output: '', status: 200 }) }));

// What the cloud host and the device route need besides the SDK. The database answers the cloud's
// lease check, the device route's run (as it is now) and the connection.
const URL_ = 'https://mcp.example.test/mcp';
const RUN = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const CONN = '33333333-3333-4333-8333-333333333333';
let leaseHeld = true;
let run: Record<string, unknown> = {};
const queries: string[] = [];
vi.mock('../src/lib/db', () => ({
  db: () => (strings: TemplateStringsArray) => {
    const text = strings.join('?').replace(/\s+/g, ' ');
    queries.push(text);
    if (text.includes('from public.runs r join public.agents')) return Promise.resolve([run]);
    if (text.includes('from public.connections')) return Promise.resolve([{ id: CONN, config: { url: URL_, tools: [{ name: 'send_email', inputSchema: {} }] } }]);
    return Promise.resolve(text.includes('lease_id') && !leaseHeld ? [] : [{ x: 1 }]);
  },
}));
vi.mock('../src/lib/cleanup', () => ({ cleanUp: async () => {} }));
vi.mock('../src/lib/blob', () => ({ guessMime: () => 'application/octet-stream', saveArtifact: async () => ({}), readArtifactBytes: async () => null }));
vi.mock('../src/lib/env', () => ({ env: {} }));
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
vi.mock('../src/lib/models', () => ({ connectionSecret: async () => null }));
vi.mock('../src/lib/platform-credits', () => ({ assertPlatformAllowed: () => {}, operatorGatewayToken: async () => '' }));
vi.mock('../src/lib/runs', () => ({ decideApproval: async () => ({}), finishRun: async () => 'ended', taskTx: async () => [] }));
vi.mock('../src/lib/runner/store', () => ({ DbRunStore: class {} }));
// The route imports through the app's '@/' alias, which vitest doesn't resolve: each is the module above
// (the real one for http and mcp).
vi.mock('@/lib/auth', () => import('../src/lib/auth'));
vi.mock('@/lib/blob', () => import('../src/lib/blob'));
vi.mock('@/lib/db', () => import('../src/lib/db'));
vi.mock('@/lib/http', () => import('../src/lib/http'));
vi.mock('@/lib/mcp', () => import('../src/lib/mcp'));
vi.mock('@/lib/models', () => import('../src/lib/models'));
vi.mock('@/lib/platform-credits', () => import('../src/lib/platform-credits'));
vi.mock('@/lib/runs', () => import('../src/lib/runs'));
vi.mock('@/lib/runner/store', () => import('../src/lib/runner/store'));

const { callMcp, mcpNamespace } = await import('../src/lib/mcp');
const { SandboxHost } = await import('../src/lib/runner/sandbox-host');
const { POST } = (await import('../src/app/api/device/runs/[id]/[action]/route')) as unknown as { POST: (req: Request, ctx: { params: Promise<{ id: string; action: string }> }) => Promise<Response> };

const STOPPED = { output: 'The connected tool was not called because the task was stopped.', isError: true };

/** Let pending promises run until `ready()` (the stand-in got the connect, say). */
async function until(ready: () => boolean) {
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 0));
  expect(ready()).toBe(true);
}

beforeEach(() => {
  sdk.hold = true;
  sdk.connects = [];
  sdk.calls = [];
  sdk.closed = 0;
  sdk.release = () => {};
  sdk.callTool = async () => ({ content: [{ type: 'text', text: 'sent' }] });
  leaseHeld = true;
  run = { id: RUN, session_id: 's', agent_id: 'a', user_id: 'user-1', agent_name: 'A', model: { source: 'openai' }, lease_id: LEASE, status: 'running', cancel_requested: false };
  queries.length = 0;
});
afterEach(() => sdk.release()); // nothing is left waiting on a connect

describe('an MCP call after a Stop (W-190)', () => {
  it('is not sent when the task is stopped while connecting, and the client is closed', async () => {
    const stop = new AbortController();
    const p = callMcp(URL_, undefined, 'send_email', { to: 'x' }, { signal: stop.signal });
    await until(() => sdk.connects.length === 1);
    stop.abort();
    sdk.release(); // the server answers initialize after all
    expect(await p).toEqual(STOPPED);
    expect(sdk.calls).toHaveLength(0);
    expect(sdk.closed).toBe(1);
    // The SDK got a signal for initialize too, and it ended with the Stop.
    expect(sdk.connects[0].signal?.aborted).toBe(true);
  });

  it('is not sent when the task no longer wants it right before the call', async () => {
    let wanted = true;
    const p = callMcp(URL_, undefined, 'send_email', {}, { stillWanted: () => wanted });
    await until(() => sdk.connects.length === 1);
    wanted = false; // a Stop recorded while connecting, with no signal (a cloud tick has none)
    sdk.release();
    expect(await p).toEqual(STOPPED);
    expect(sdk.calls).toHaveLength(0);
    expect(sdk.closed).toBe(1);
  });

  it('passes the signal on to the call', async () => {
    sdk.hold = false;
    const stop = new AbortController();
    const r = await callMcp(URL_, 'not-a-real-token', 'send_email', { to: 'x' }, { signal: stop.signal, stillWanted: async () => true });
    expect(r).toEqual({ output: 'sent', isError: false });
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0].params).toEqual({ name: 'send_email', arguments: { to: 'x' } });
    const passed = sdk.calls[0].options?.signal;
    expect(passed).toBeInstanceOf(AbortSignal);
    expect(passed?.aborted).toBe(false);
    stop.abort();
    expect(passed?.aborted).toBe(true);
    expect(sdk.closed).toBe(1);
  });

  it('says a call stopped while running may or may not have finished', async () => {
    sdk.hold = false;
    sdk.callTool = (o) => new Promise((_, reject) => o?.signal?.addEventListener('abort', () => reject(new Error('cancelled'))));
    const stop = new AbortController();
    const p = callMcp(URL_, undefined, 'send_email', {}, { signal: stop.signal });
    await until(() => sdk.calls.length === 1);
    stop.abort();
    expect(await p).toEqual({ output: 'The task was stopped while the connected tool was running; it may or may not have finished.', isError: true });
    expect(sdk.closed).toBe(1);
  });

  it("doesn't call the tool when connecting outlasts its time", async () => {
    const r = await callMcp(URL_, undefined, 'send_email', {}, { timeoutMs: 20 });
    expect(r).toEqual({ output: "The connected tool's server didn't answer in time, so the tool was not called.", isError: true });
    expect(sdk.calls).toHaveLength(0);
    expect(sdk.closed).toBe(1);
  });
});

describe("the cloud host's MCP tools after a Stop (W-190)", () => {
  const host = (leaseId?: string) =>
    new SandboxHost({ agentId: 'a', userId: 'u', sessionId: 's', runId: 'r', leaseId, mcp: new Map([['mcp_abc123', { url: URL_, tools: [{ name: 'send_email', inputSchema: {} }] }]]) });
  const ctx = (over: { signal?: AbortSignal; isCancelled?: () => Promise<boolean> } = {}) => ({
    runtime: 'cloud' as const,
    deadline: Date.now() + 200_000,
    callId: 'c',
    checkpoint: async () => {},
    isCancelled: async () => false,
    ...over,
  });

  it('sends no tools/call when the run is stopped while connecting', async () => {
    const stop = new AbortController();
    const p = host().execute('mcp_abc123.send_email', { to: 'x' }, ctx({ signal: stop.signal }));
    await until(() => sdk.connects.length === 1);
    stop.abort();
    sdk.release();
    expect(await p).toEqual(STOPPED);
    expect({ toolsCallCount: sdk.calls.length, closed: sdk.closed > 0 }).toEqual({ toolsCallCount: 0, closed: true });
  });

  it('sends none when Stop is recorded while connecting', async () => {
    let cancelled = false;
    const p = host('lease-1').execute('mcp_abc123.send_email', {}, ctx({ isCancelled: async () => cancelled }));
    await until(() => sdk.connects.length === 1);
    cancelled = true;
    sdk.release();
    expect(await p).toEqual(STOPPED);
    expect(sdk.calls).toHaveLength(0);
    expect(sdk.closed).toBe(1);
  });

  it('sends none once the tick lost the run, and calls it while it holds it', async () => {
    let p = host('lease-1').execute('mcp_abc123.send_email', {}, ctx());
    await until(() => sdk.connects.length === 1);
    leaseHeld = false;
    sdk.release();
    expect(await p).toEqual(STOPPED);
    expect(sdk.calls).toHaveLength(0);
    expect(queries.some((q) => q.includes('lease_id'))).toBe(true);

    leaseHeld = true;
    p = host('lease-1').execute('mcp_abc123.send_email', {}, ctx());
    await until(() => sdk.connects.length === 2);
    sdk.release();
    expect(await p).toEqual({ output: 'sent', isError: false });
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0].options?.signal).toBeInstanceOf(AbortSignal); // bounded by the tick's deadline
    expect(sdk.closed).toBe(2);
  });
});

describe("the device route's MCP calls after a Stop (W-190)", () => {
  const call = (signal?: AbortSignal) =>
    POST(
      new Request(`http://wren.test/api/device/runs/${RUN}/mcp`, {
        method: 'POST',
        headers: { authorization: 'Device not-a-real-token', 'x-wren-lease': LEASE, 'content-type': 'application/json' },
        body: JSON.stringify({ name: `${mcpNamespace(CONN)}.send_email`, args: { to: 'x' } }),
        signal,
      }),
      { params: Promise.resolve({ id: RUN, action: 'mcp' }) },
    );
  const runReads = () => queries.filter((q) => q.includes('from public.runs r join public.agents')).length;

  it('calls nothing when Stop is recorded while connecting', async () => {
    const res = call();
    await until(() => sdk.connects.length === 1);
    run = { ...run, cancel_requested: true };
    sdk.release();
    expect(await (await res).json()).toEqual(STOPPED);
    expect(sdk.calls).toHaveLength(0);
    expect(sdk.closed).toBe(1);
  });

  it('calls nothing once the run ended or another lease holds it', async () => {
    for (const now of [{ status: 'cancelled', lease_id: null }, { lease_id: '44444444-4444-4444-8444-444444444444' }]) {
      const res = call();
      await until(() => sdk.connects.length === 1);
      run = { ...run, ...now };
      sdk.release();
      const r = await res;
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ code: 'lease_lost' });
      expect(sdk.calls).toHaveLength(0);
      expect(sdk.closed).toBe(1);
      sdk.connects = [];
      sdk.closed = 0;
      run = { ...run, status: 'running', lease_id: LEASE };
    }
  });

  it("calls nothing when the device's Stop aborts the request while connecting", async () => {
    const stop = new AbortController();
    const res = call(stop.signal);
    await until(() => sdk.connects.length === 1);
    stop.abort();
    sdk.release();
    expect(await (await res).json()).toEqual(STOPPED);
    expect(sdk.calls).toHaveLength(0);
    expect(sdk.closed).toBe(1);
  });

  it('calls the tool while the run still wants it, after reading the run again', async () => {
    const res = call(new AbortController().signal);
    await until(() => sdk.connects.length === 1);
    sdk.release();
    expect(await (await res).json()).toEqual({ output: 'sent', isError: false });
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0].options?.signal).toBeInstanceOf(AbortSignal);
    expect(runReads()).toBeGreaterThan(1); // once to start, again before the call
  });
});
