import { request } from 'node:http';

// How Wren's engine helpers (the MCP server Claude Code starts, Grok Build's PreToolUse hook) reach the
// approval bridge in Wren's main process. Not fetch: Node's fetch gives up on a request whose answer hasn't
// started within 300 s (undici's headersTimeout, `UND_ERR_HEADERS_TIMEOUT`, checked in Electron 44's Node),
// and an answer here waits for a person (an approval) or another agent (an answer). Before 0.1.47 a
// permission prompt left for five minutes was denied and withdrawn, and an ask failed after five.
// node:http sets no time limit of its own, so each helper gives its own deadline (below), each shorter than
// the engine's own limit on the call, so Wren's answer (a deny) always arrives before the engine gives up.

/**
 * How long Wren waits for a person to decide (`decide` in common.ts); every limit below is longer, so the
 * helpers get that "no approval arrived in time" answer rather than giving up first.
 */
export const APPROVAL_WAIT_MS = 50 * 60_000;
/** How long Wren waits for another agent's answer (the server stops asked tasks after an hour too). */
export const ASK_WAIT_MS = 60 * 60_000;
/** The MCP helper's own deadline for a permission prompt, and Grok's hook's (Grok's hook timeout is 3600 s). */
export const APPROVE_HELPER_MS = 55 * 60_000;
/** The MCP helper's own deadline for an ask_agent call. */
export const ASK_HELPER_MS = 62 * 60_000;
/**
 * Claude Code's limits on a call to Wren's MCP helper, total (`MCP_TOOL_TIMEOUT`) and without word from it
 * (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, 30 minutes for a stdio server by default in 2.1.322).
 */
export const ENGINE_MCP_TIMEOUT_MS = 65 * 60_000;

/** The most the bridge's answer may be (an approval echoes the tool's input, itself at most 512 KB). */
const MAX_ANSWER_BYTES = 16 * 1024 * 1024;

/**
 * POST `body` as JSON to the bridge at `url` (only http://127.0.0.1:<port>) and give back its JSON answer.
 * `signal` (the engine took its call back) and `timeoutMs` end the request; either way it rejects.
 */
export function postToWren(url: string, token: string, body: unknown, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error('Wren approval bridge is not configured.'));
    }
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !/^\d+$/.test(u.port) || u.username || u.password || !token) return reject(new Error('Wren approval bridge is not configured.'));
    if (opts.signal?.aborted) return reject(new Error('The request was called off.'));
    const data = Buffer.from(JSON.stringify(body));
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const fail = (e: Error) => finish(() => reject(e));
    const req = request(
      {
        host: '127.0.0.1',
        port: Number(u.port),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: `Bearer ${token}` },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_ANSWER_BYTES) return void req.destroy(new Error('Wren’s answer was too large.'));
          chunks.push(c);
        });
        res.on('end', () => {
          // Only the bridge's own decision counts: anything else (a refusal, an error page) is no answer.
          if (res.statusCode !== 200) return fail(new Error(`Wren answered ${res.statusCode ?? 'without a status'}.`));
          try {
            const answer: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(() => resolve(answer));
          } catch {
            fail(new Error('Wren answered with no decision.'));
          }
        });
        res.on('error', fail);
        // After a whole answer this does nothing (it settled at `end`).
        res.on('close', () => fail(new Error('Wren’s answer was cut off.')));
      },
    );
    const onAbort = () => req.destroy(new Error('The request was called off.'));
    const timer = opts.timeoutMs ? setTimeout(() => req.destroy(new Error('No answer from Wren in time.')), opts.timeoutMs) : undefined;
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', fail);
    req.end(data);
  });
}

/** Each name once, compared trimmed and ignoring case, keeping the first spelling (Wren matches names that way). */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, string>();
  for (const n of names) {
    const name = n.trim();
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()];
}
