import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}));
process.env.WREN_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'wren-mcp-data-')));
const { saveDevice } = await import('../src/main/config');
const { LocalHost } = await import('../src/main/host');

// A linked computer (fabricated sign-in) whose requests go to a stand-in server that never answers.
saveDevice({ deviceId: 'device-1', token: 'not-a-real-token', channel: 'c', supabase: { url: 'http://wren.test', key: 'k' }, appUrl: 'http://wren.test' });
const policy = () => ({ folders: [], shell: false, browser: false, screen: false }) as never;
const ctx = { runtime: 'desktop' as const, deadline: Date.now() + 60_000, callId: 'c', checkpoint: async () => {} };

afterEach(() => vi.unstubAllGlobals());

describe('connected tools on this computer after a Stop (W-190)', () => {
  it("abort the server's MCP request, so a call it hasn't sent yet never is", async () => {
    const seen: { url: string; signal?: AbortSignal | null }[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      seen.push({ url, signal: init.signal });
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    });
    const stop = new AbortController();
    const p = new LocalHost(policy, 'run-a', 'lease-a').execute('mcp_abc123.send_email', { to: 'x' }, { ...ctx, signal: stop.signal });
    for (let i = 0; i < 100 && !seen.length; i++) await new Promise((r) => setTimeout(r, 0));
    expect(seen.map((s) => s.url)).toEqual(['http://wren.test/api/device/runs/run-a/mcp']);
    expect(seen[0].signal).toBe(stop.signal);
    stop.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });
});
