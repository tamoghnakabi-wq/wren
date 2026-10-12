import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let encryption = true;
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' },
  safeStorage: { isEncryptionAvailable: () => encryption, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}));
process.env.WREN_DATA_DIR = mkdtempSync(join(tmpdir(), 'wren-revoke-'));
const { giveBack, retryGiveBacks } = await import('../src/main/revoke');
const file = join(process.env.WREN_DATA_DIR!, 'revoke-pending.bin');
const recorded = () => existsSync(file) && statSync(file).size > 0;
const answer = (status: number, body: unknown) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  encryption = true;
});

// W-148: a token given back is never just forgotten when the server can't confirm it.
describe('giving a device token back', () => {
  it('keeps it (recorded before the request) until the server confirms, and retries it', async () => {
    let seenDuring = false;
    vi.stubGlobal('fetch', async () => {
      seenDuring = recorded();
      throw new Error('offline');
    });
    expect(await giveBack('tok-1', 'https://wren.example')).toBe('pending');
    expect(seenDuring).toBe(true);

    vi.stubGlobal('fetch', answer(500, { error: 'boom' }));
    expect(await retryGiveBacks()).toBe(1); // a server error isn't a confirmation

    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => (calls.push(`${url} ${new Headers(init.headers).get('authorization')} ${init.redirect}`), new Response('{"ok":true}')));
    expect(await retryGiveBacks()).toBe(0);
    expect(calls).toEqual(['https://wren.example/api/device/unlink Device tok-1 error']);
    expect(recorded()).toBe(false);
  });

  it("counts Wren's own answer that the token is no longer accepted as given back", async () => {
    vi.stubGlobal('fetch', answer(401, { error: 'This device is not linked or was removed.', code: 'device_revoked' }));
    expect(await giveBack('tok-2')).toBe('confirmed');
    expect(await retryGiveBacks()).toBe(0);
  });

  // W-150: only Wren's own answers count.
  it("doesn't count a proxy's 401, a sign-in page, an unexpected body or a redirect", async () => {
    for (const reply of [answer(401, 'Unauthorized'), answer(401, { error: 'Authentication required' }), answer(200, '<html>Sign in</html>'), answer(200, { status: 'up' })]) {
      vi.stubGlobal('fetch', reply);
      expect(await giveBack('tok-3')).toBe('pending');
    }
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed: redirect mode is set to error');
    });
    expect(await retryGiveBacks()).toBe(1);
    vi.stubGlobal('fetch', answer(200, { ok: true }));
    expect(await retryGiveBacks()).toBe(0);
  });

  it("says when it couldn't even be recorded, and never overwrites a record it can't read now", async () => {
    vi.stubGlobal('fetch', answer(503, {}));
    writeFileSync(file, JSON.stringify([{ token: 'tok-old', appUrl: 'https://wren.example' }]));
    encryption = false; // the keychain is unavailable for now
    expect(await giveBack('tok-4')).toBe('failed');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([{ token: 'tok-old', appUrl: 'https://wren.example' }]);
    encryption = true;
    expect(await retryGiveBacks()).toBe(1); // readable again: still there
  });

  it("moves aside a record secure storage can't read (a reset keychain), instead of blocking every later give-back", async () => {
    vi.stubGlobal('fetch', answer(503, {}));
    writeFileSync(file, 'not readable as a list');
    expect(await giveBack('tok-5')).toBe('pending');
    const aside = readdirSync(process.env.WREN_DATA_DIR!).filter((f) => f.startsWith('revoke-pending.unreadable-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(process.env.WREN_DATA_DIR!, aside[0]), 'utf8')).toBe('not readable as a list');
    vi.stubGlobal('fetch', answer(200, { ok: true }));
    expect(await retryGiveBacks()).toBe(0);
  });
});
