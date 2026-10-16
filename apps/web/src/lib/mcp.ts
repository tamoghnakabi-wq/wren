import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assertPublicUrl, guardedFetch } from '@wren/core/net';
import type { ToolSpec } from '@wren/core';

// Remote MCP servers (Streamable HTTP) as connected tools. Each server's tools
// are exposed to the model under its own namespace: mcp_<6 hex of conn id>.

export interface McpToolInfo {
  name: string;
  description?: string;
  readOnly?: boolean;
  inputSchema: Record<string, unknown>;
}

async function open(url: string, token?: string) {
  const u = await assertPublicUrl(url);
  // A token sent over plain http can be read on the way (W-170): checked here, so both adding a
  // connection and every later call refuse it.
  if (token && u.protocol !== 'https:') throw new Error('An MCP server that needs a token must use an https:// address.');
  const client = new Client({ name: 'wren', version: '0.1.0' });
  // guardedFetch re-checks the address on every connection (DNS can change after assertPublicUrl).
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: guardedFetch, requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} } });
  return { client, transport };
}

async function connect(url: string, token?: string) {
  const { client, transport } = await open(url, token);
  await client.connect(transport);
  return client;
}

export async function probeMcp(url: string, token?: string): Promise<McpToolInfo[]> {
  const client = await connect(url, token);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => ({ name: t.name, description: t.description, readOnly: t.annotations?.readOnlyHint === true, inputSchema: t.inputSchema as Record<string, unknown> }));
  } finally {
    await client.close().catch(() => {});
  }
}

export function mcpNamespace(connectionId: string) {
  return `mcp_${connectionId.replace(/-/g, '').slice(0, 6)}`;
}

export function mcpToolSpecs(connectionId: string, label: string, tools: McpToolInfo[]): ToolSpec[] {
  const ns = mcpNamespace(connectionId);
  return tools.slice(0, 40).map((t) => ({
    namespace: ns,
    name: t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48),
    description: `[${label}] ${t.description ?? t.name}`.slice(0, 1000),
    parameters: { type: 'object', properties: {}, ...(t.inputSchema ?? {}) },
  }));
}

export interface McpCallOptions {
  /** The task's Stop (or the request that asked for the call going away): ends connecting and the call. */
  signal?: AbortSignal;
  /** Asked after every wait before the call and right before it: false means the task no longer wants it. */
  stillWanted?: () => boolean | Promise<boolean>;
  /** Time for connecting and the call together. */
  timeoutMs?: number;
}

const STOPPED = 'The connected tool was not called because the task was stopped.';
const SLOW = "The connected tool's server didn't answer in time, so the tool was not called.";

/**
 * Call one tool. Connecting can take a while, and a Stop or a lost lease that comes meanwhile must
 * mean the call is never sent (W-190), so the task is asked again after every wait and right before
 * the call. A call the server already received may still finish there; that can't be called back.
 */
export async function callMcp(url: string, token: string | undefined, tool: string, args: Record<string, unknown>, opts: McpCallOptions = {}): Promise<{ output: string; isError: boolean }> {
  const timer = opts.timeoutMs !== undefined ? AbortSignal.timeout(Math.max(0, opts.timeoutMs)) : undefined;
  const sources = [opts.signal, timer].filter((s): s is AbortSignal => !!s);
  // A signal of this call's own: the SDK adds a listener per request and never removes it.
  const signal = sources.length ? AbortSignal.any(sources) : undefined;
  const timedOut = () => !!timer?.aborted && !opts.signal?.aborted;
  const unwanted = async () => !!signal?.aborted || (opts.stillWanted ? !(await opts.stillWanted()) : false) || !!signal?.aborted;
  const notCalled = () => ({ output: timedOut() ? SLOW : STOPPED, isError: true });

  const { client, transport } = await open(url, token);
  try {
    if (await unwanted()) return notCalled();
    try {
      await untilAborted(client.connect(transport, { signal }), signal);
    } catch (e) {
      if (signal?.aborted) return notCalled();
      throw e;
    }
    if (await unwanted()) return notCalled();
    let r: Awaited<ReturnType<Client['callTool']>>;
    try {
      r = await client.callTool({ name: tool, arguments: args }, undefined, { signal });
    } catch (e) {
      if (!signal?.aborted) throw e;
      // It was sent, so the server may have acted on it (the SDK tells it the call was cancelled).
      return { output: timedOut() ? "The connected tool didn't answer in time; it may or may not have finished." : 'The task was stopped while the connected tool was running; it may or may not have finished.', isError: true };
    }
    const parts = (r.content as { type: string; text?: string }[] | undefined) ?? [];
    const text = parts.map((p) => (p.type === 'text' ? p.text : `[${p.type} content]`)).join('\n');
    return { output: text || JSON.stringify(r.structuredContent ?? {}), isError: !!r.isError };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * `p`, or a rejection as soon as `signal` aborts: connecting also sends a notification and starts the
 * transport, which take no signal. Whatever `p` was still doing ends when the client is closed.
 */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
