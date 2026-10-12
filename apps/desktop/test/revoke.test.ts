import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

let encryption = true;
let decryptFails = false;
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' },
  safeStorage: {
    isEncryptionAvailable: () => encryption,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => {
      if (decryptFails) throw new Error('Error while decrypting the ciphertext');
      return b.toString();
    },
  },
}));
process.env.WREN_DATA_DIR = mkdtempSync(join(tmpdir(), 'wren-revoke-'));
const { giveBack, retryGiveBacks } = await import('../src/main/revoke');
const file = join(process.env.WREN_DATA_DIR!, 'revoke-pending.bin');
const recorded = () => existsSync(file) && statSync(file).size > 0;
const answer = (status: number, body: unknown) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

const held = () => readdirSync(process.env.WREN_DATA_DIR!).filter((f) => f.startsWith('revoke-pending.held-') || f.startsWith('revoke-pending.unreadable-'));

afterEach(async () => {
  vi.unstubAllGlobals();
  encryption = true;
  decryptFails = false;
  vi.stubGlobal('fetch', answer(200, { ok: true }));
  await retryGiveBacks(); // leave nothing waiting for the next test
  vi.unstubAllGlobals();
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

  // W-155: a record that can't be read when a token is added is set aside and retried, never dropped.
  it("sets a record it can't read now aside and retries it once it can (a read error)", async () => {
    vi.stubGlobal('fetch', answer(503, {}));
    expect(await giveBack('tok-old', 'https://wren.example')).toBe('pending');
    decryptFails = true; // e.g. the keychain refused once
    expect(await giveBack('tok-new', 'https://wren.example')).toBe('pending');
    expect(held()).toHaveLength(1);
    expect(await retryGiveBacks()).toBe(2); // the new token, and the record it can't read yet
    decryptFails = false;
    const revoked: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => (revoked.push(new Headers(init.headers).get('authorization')!), new Response('{"ok":true}')));
    expect(await retryGiveBacks()).toBe(0);
    expect(revoked.sort()).toEqual(['Device tok-new', 'Device tok-old']);
    expect(held()).toHaveLength(0);
  });

  it('says when it couldn\'t even be recorded (the keychain unavailable), and still keeps what was recorded before', async () => {
    vi.stubGlobal('fetch', answer(503, {}));
    expect(await giveBack('tok-a', 'https://wren.example')).toBe('pending');
    encryption = false;
    expect(await giveBack('tok-b')).toBe('failed');
    encryption = true;
    const revoked: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => (revoked.push(new Headers(init.headers).get('authorization')!), new Response('{"ok":true}')));
    expect(await retryGiveBacks()).toBe(0);
    expect(revoked).toEqual(['Device tok-a']);
  });

  it('keeps the good entries of a record with a damaged one, and keeps a record it can never read', async () => {
    writeFileSync(file, JSON.stringify([{ token: 'tok-c', appUrl: 'https://wren.example' }, { nonsense: true }]));
    const revoked: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => (revoked.push(new Headers(init.headers).get('authorization')!), new Response('{"ok":true}')));
    expect(await retryGiveBacks()).toBe(0);
    expect(revoked).toEqual(['Device tok-c']);

    vi.stubGlobal('fetch', answer(503, {}));
    writeFileSync(file, 'not readable as a list');
    expect(await giveBack('tok-d')).toBe('pending');
    expect(held()).toHaveLength(1);
    expect(readFileSync(join(process.env.WREN_DATA_DIR!, held()[0]), 'utf8')).toBe('not readable as a list');
    expect(await retryGiveBacks()).toBe(2); // tok-d, and the record that stays unreadable: never dropped
    rmSync(join(process.env.WREN_DATA_DIR!, held()[0]));
  });
});
