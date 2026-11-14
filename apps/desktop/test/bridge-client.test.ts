import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_WAIT_MS, APPROVE_HELPER_MS, ASK_HELPER_MS, ASK_WAIT_MS, ENGINE_MCP_TIMEOUT_MS, postToWren, uniqueNames } from '../src/engines/bridge-client';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
process.env.WREN_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'wren-data-')));

// How the engine helpers reach Wren's approval bridge (0.1.47). They used fetch, whose answer has to start
// within 300 s, so a permission prompt left for five minutes was denied and withdrawn and an ask failed.
// The 310 s case itself runs against the built helpers (CLAUDE.md, "slow helpers"); these cover the rest.

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A stand-in bridge that answers each request with `answer`. */
async function bridge(answer: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: { auth?: string; body: string; closedEarly: boolean }[] = [];
  const server = createServer((req, res) => {
    const r = { auth: req.headers.authorization, body: '', closedEarly: false };
    seen.push(r);
    req.on('data', (c) => (r.body += c));
    req.on('end', () => answer(req, res));
    res.on('close', () => (r.closedEarly = !res.writableEnded));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  servers.push({ close: () => server.close() });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/approve`, seen };
}

describe('the helpers’ way to Wren', () => {
  it('posts the request with the token and gives back the decision', async () => {
    const b = await bridge((_req, res) => res.end(JSON.stringify({ behavior: 'allow', updatedInput: { command: 'ls' } })));
    expect(await postToWren(b.url, 'tok', { tool_name: 'Bash', input: { command: 'ls' } })).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(b.seen[0]).toMatchObject({ auth: 'Bearer tok', body: JSON.stringify({ tool_name: 'Bash', input: { command: 'ls' } }) });
  });

  it('goes nowhere but http://127.0.0.1:<port>, and never without a token', async () => {
    for (const url of ['', 'not a url', 'https://127.0.0.1:4000/approve', 'http://localhost:4000/approve', 'http://10.0.0.1:4000/approve', 'http://127.0.0.1/approve', 'http://user:pw@127.0.0.1:4000/approve', 'file:///etc/passwd']) {
      await expect(postToWren(url, 'tok', {}), url).rejects.toThrow('not configured');
    }
    const b = await bridge((_req, res) => res.end('{}'));
    await expect(postToWren(b.url, '', {})).rejects.toThrow('not configured');
    expect(b.seen).toHaveLength(0);
  });

  it('counts only the bridge’s own answer: no other status, no answer that isn’t JSON', async () => {
    const refusing = await bridge((_req, res) => ((res.statusCode = 503), res.end(JSON.stringify({ behavior: 'allow' }))));
    await expect(postToWren(refusing.url, 'tok', {})).rejects.toThrow('Wren answered 503.');
    const garbled = await bridge((_req, res) => res.end('<html>'));
    await expect(postToWren(garbled.url, 'tok', {})).rejects.toThrow('no decision');
    const cut = await bridge((_req, res) => {
      res.write('{"behavior":');
      setTimeout(() => res.destroy(), 20);
    });
    await expect(postToWren(cut.url, 'tok', {})).rejects.toThrow();
  });

  it('stops reading an answer past 16 MB', async () => {
    const b = await bridge((_req, res) => {
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      let sent = 0;
      const more = () => {
        while (sent < 20 && res.write(chunk)) sent++;
        if (sent < 20) res.once('drain', more);
        else res.end();
      };
      res.on('error', () => {});
      more();
    });
    await expect(postToWren(b.url, 'tok', {})).rejects.toThrow('too large');
  });

  it('gives up at its own deadline, and when the engine calls its request off, ending the request either way', async () => {
    const b = await bridge(() => {}); // a person who never decides
    await expect(postToWren(b.url, 'tok', {}, { timeoutMs: 100 })).rejects.toThrow('No answer from Wren in time.');
    const call = new AbortController();
    const waiting = postToWren(b.url, 'tok', {}, { signal: call.signal });
    await vi.waitFor(() => expect(b.seen).toHaveLength(2));
    call.abort();
    await expect(waiting).rejects.toThrow('called off');
    // The bridge sees the request go: that is what withdraws the approval or stops the asked task (W-129).
    await vi.waitFor(() => expect(b.seen.every((r) => r.closedEarly)).toBe(true));
    await expect(postToWren(b.url, 'tok', {}, { signal: AbortSignal.abort() })).rejects.toThrow('called off');
    expect(b.seen).toHaveLength(2);
  });

  it('leaves nothing behind on the engine’s signal', async () => {
    const { getEventListeners } = await import('node:events');
    const b = await bridge((_req, res) => res.end('{"behavior":"deny"}'));
    const call = new AbortController();
    for (let i = 0; i < 12; i++) await postToWren(b.url, 'tok', {}, { signal: call.signal, timeoutMs: 60_000 });
    expect(getEventListeners(call.signal, 'abort')).toHaveLength(0);
  });

  it('ends each wait before the next one up gives up, so the answer is always Wren’s', () => {
    // A person: Wren (decide) < the helpers < Grok's hook timeout (3600 s, which Grok treats as "allow")
    // and Claude Code's limits on the call.
    expect(APPROVAL_WAIT_MS).toBeLessThan(APPROVE_HELPER_MS);
    expect(APPROVE_HELPER_MS).toBeLessThan(3600 * 1000);
    expect(APPROVE_HELPER_MS).toBeLessThan(ENGINE_MCP_TIMEOUT_MS);
    // Another agent: Wren's wait < the helper's < Claude Code's.
    expect(ASK_WAIT_MS).toBeLessThan(ASK_HELPER_MS);
    expect(ASK_HELPER_MS).toBeLessThan(ENGINE_MCP_TIMEOUT_MS);
  });

  it('lists each agent name once, as Wren matches them', () => {
    expect(uniqueNames(['Claude', ' claude ', 'CLAUDE', 'Scout', '  ', 'scout'])).toEqual(['Claude', 'Scout']);
  });
});
