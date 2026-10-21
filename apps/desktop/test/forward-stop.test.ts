import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}));
// web.fetch itself is tested in core (W-196); here only what the host hands it.
const fetched: { url: string; o: { signal?: AbortSignal } }[] = [];
vi.mock('@wren/core/net', () => ({
  fetchReadable: async (url: string, o: { signal?: AbortSignal }) => {
    fetched.push({ url, o });
    return { output: 'page', status: 200, finalUrl: url };
  },
}));
process.env.WREN_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'wren-forward-data-')));
const { saveDevice } = await import('../src/main/config');
const { LocalHost } = await import('../src/main/host');

// A linked computer (fabricated sign-in) whose requests go to a stand-in server that never answers.
saveDevice({ deviceId: 'device-1', token: 'not-a-real-token', channel: 'c', supabase: { url: 'http://wren.test', key: 'k' }, appUrl: 'http://wren.test' });
const policy = () => ({ folders: [], shell: false, browser: false, screen: false }) as never;
const ctx = { runtime: 'desktop' as const, deadline: Date.now() + 60_000, callId: 'c', checkpoint: async () => {} };

afterEach(() => vi.unstubAllGlobals());

describe("this computer's GitHub and web requests after a Stop", () => {
  it("github.request aborts the server's request, so one it hasn't sent to GitHub yet never is (W-194)", async () => {
    const seen: { url: string; signal?: AbortSignal | null }[] = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      seen.push({ url, signal: init.signal });
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    });
    const stop = new AbortController();
    const p = new LocalHost(policy, 'run-a', 'lease-a').execute('github.request', { method: 'POST', path: '/repos/o/r/issues', body: {} }, { ...ctx, signal: stop.signal });
    for (let i = 0; i < 100 && !seen.length; i++) await new Promise((r) => setTimeout(r, 0));
    expect(seen.map((s) => s.url)).toEqual(['http://wren.test/api/device/runs/run-a/github']);
    expect(seen[0].signal).toBe(stop.signal);
    stop.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });

  it('web.fetch gets the Stop signal (W-196)', async () => {
    const stop = new AbortController();
    expect(await new LocalHost(policy, 'run-a', 'lease-a').execute('web.fetch', { url: 'https://example.test/' }, { ...ctx, signal: stop.signal })).toEqual({ output: 'page', isError: false });
    expect(fetched).toHaveLength(1);
    expect(fetched[0].o.signal).toBe(stop.signal);
  });
});
