import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}));
process.env.WREN_DATA_DIR = mkdtempSync(join(tmpdir(), 'wren-revoke-'));
const { giveBack, retryGiveBacks } = await import('../src/main/revoke');
const file = join(process.env.WREN_DATA_DIR!, 'revoke-pending.bin');
const recorded = () => existsSync(file) && statSync(file).size > 0;

afterEach(() => vi.unstubAllGlobals());

// W-148: a token given back is never just forgotten when the server can't confirm it.
describe('giving a device token back', () => {
  it('keeps it (recorded before the request) until the server confirms, and retries it', async () => {
    let seenDuring = false;
    vi.stubGlobal('fetch', async () => {
      seenDuring = recorded();
      throw new Error('offline');
    });
    expect(await giveBack('tok-1', 'https://wren.example')).toBe(false);
    expect(seenDuring).toBe(true);
    expect(recorded()).toBe(true);

    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }));
    expect(await retryGiveBacks()).toBe(1); // a server error isn't a confirmation

    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => (calls.push(`${url} ${new Headers(init.headers).get('authorization')}`), new Response('{"ok":true}')));
    expect(await retryGiveBacks()).toBe(0);
    expect(calls).toEqual(['https://wren.example/api/device/unlink Device tok-1']);
    expect(recorded()).toBe(false);
  });

  it('counts a token the server already refuses (401) as given back', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"code":"device_revoked"}', { status: 401 }));
    expect(await giveBack('tok-2')).toBe(true);
    expect(await retryGiveBacks()).toBe(0);
  });
});
