import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Mode, OpenMode, RmOptions, WriteFileOptions } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Sign in with ChatGPT, against stand-ins: a fake browser (the authorize URL is opened by the test, which
// then calls the loopback callback), a fake token endpoint and ID-token check, and pass-through
// "encryption". No network and no real keychain.
const data = mkdtempSync(join(tmpdir(), 'wren-chatgpt-'));
process.env.WREN_DATA_DIR = data;
const opened: string[] = [];
// Files nothing may replace, remove or open for writing, as macOS's "locked" flag does: one file's clean-up
// fails while its folder stays writable, which permissions alone can't do.
const { locked } = vi.hoisted(() => ({ locked: new Set<string>() }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const refuse = (p: unknown) => {
    if (locked.has(String(p))) throw Object.assign(new Error(`EPERM: operation not permitted, '${String(p)}'`), { code: 'EPERM' });
  };
  return {
    ...fs,
    renameSync: (from: string, to: string) => (refuse(to), fs.renameSync(from, to)),
    rmSync: (p: string, o?: RmOptions) => (refuse(p), fs.rmSync(p, o)),
    unlinkSync: (p: string) => (refuse(p), fs.unlinkSync(p)),
    writeFileSync: (p: string | number, d: string | Buffer, o?: WriteFileOptions) => (refuse(p), fs.writeFileSync(p, d, o)),
    openSync: (p: string, flags?: OpenMode, mode?: Mode) => {
      if (flags !== undefined && flags !== 'r' && flags !== fs.constants.O_RDONLY) refuse(p);
      return fs.openSync(p, flags, mode);
    },
  };
});
vi.mock('electron', () => ({
  app: { getPath: () => data, getVersion: () => '0.0.0' },
  shell: { openExternal: async (url: string) => void opened.push(url) },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`enc:${s}`), decryptString: (b: Buffer) => b.toString().slice(4) },
}));
vi.mock('jose', () => ({ createRemoteJWKSet: () => ({}), jwtVerify: async (token: string) => ({ payload: JSON.parse(token) }) }));

const realFetch = globalThis.fetch;
const nonceOf = new Map<string, string>();
const held = new Map<string, () => void>();
const tokenAsked: string[] = [];
vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  if (String(url).endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify({ jwks_uri: 'https://jwks.test/keys', revocation_endpoint: 'https://auth.test/revoke' }));
  if (String(url).endsWith('/revoke')) return new Response('{}');
  const code = new URLSearchParams(String(init?.body)).get('code') ?? '';
  tokenAsked.push(code);
  if (held.has(code)) await new Promise<void>((r) => held.set(code, r)); // answered when the test says so
  const who = code.toLowerCase();
  return new Response(JSON.stringify({ id_token: JSON.stringify({ sub: who, nonce: nonceOf.get(code), email: `${who}@example.test` }), access_token: `access-${who}`, refresh_token: `refresh-${who}`, expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' }));
});

const chatgpt = await import('../src/main/chatgpt');
const config = await import('../src/main/config');

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
};
/** Play the browser: the user approves, and the provider sends them back with `code`. */
async function approve(attempt: number, code: string) {
  await until(() => opened.length > attempt);
  const q = new URL(opened[attempt]).searchParams;
  nonceOf.set(code, q.get('nonce')!);
  await realFetch(`${q.get('redirect_uri')}?code=${code}&state=${q.get('state')}&client_id=client-1`);
}

/** A whole sign-in as `code`'s user, through `mod`. */
async function signInAs(code: string, mod: typeof chatgpt = chatgpt) {
  const attempt = opened.length;
  const done = mod.signIn();
  done.catch(() => {}); // the caller looks at the outcome
  await approve(attempt, code);
  return done;
}
/** Wren starting again: fresh modules over the same data folder, nothing kept in memory. */
async function restart(): Promise<typeof chatgpt> {
  vi.resetModules();
  return import('../src/main/chatgpt');
}
const bin = join(data, 'chatgpt.bin');
const marker = join(data, 'chatgpt-signed-out.json');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const root = process.getuid?.() === 0; // permissions don't stop root

afterEach(() => {
  chmodSync(data, 0o700);
  locked.clear();
});

describe('Sign in with ChatGPT', () => {
  it('keeps the newer sign-in when an older one finishes its exchange after the newer one started (W-184)', async () => {
    held.set('A', () => {});
    const first = chatgpt.signIn();
    await approve(0, 'A');
    await until(() => tokenAsked.includes('A')); // A's code is being exchanged
    const second = chatgpt.signIn(); // the user starts over, as someone else
    await until(() => opened.length > 1);
    held.get('A')!(); // A's exchange answers only now
    await expect(first).rejects.toThrow(/cancelled/);
    await approve(1, 'B');
    expect((await second).email).toBe('b@example.test');
    expect(chatgpt.status().email).toBe('b@example.test');
  });

  it.skipIf(root)("never uses a sign-in it couldn't remove or record at sign-out, says so, and removes it once it can (W-185)", async () => {
    expect(chatgpt.status().signedIn).toBe(true);
    // Neither the data folder nor the file can be written: the stored sign-in can't be emptied, deleted or
    // emptied in place, and the sign-out can't be recorded.
    chmodSync(data, 0o500);
    chmodSync(bin, 0o400);
    try {
      expect(await chatgpt.signOut()).toMatchObject({ cleared: false, recorded: false });
      expect(readFileSync(bin).length).toBeGreaterThan(0); // still on disk...
      expect(chatgpt.status().signedIn).toBe(false); // ...but not used
      await expect(chatgpt.accessToken()).rejects.toThrow(/Not signed in/);
    } finally {
      chmodSync(data, 0o700);
      chmodSync(bin, 0o600);
    }
    expect(chatgpt.status().signedIn).toBe(false);
    expect(readFileSync(bin).length).toBe(0); // removed at the first chance
    expect(config.readSecret('chatgpt.bin')).toBeNull();
  });

  it.skipIf(root)('empties the stored sign-in where it is when only its folder can’t be changed, so a restart doesn’t use it (W-185)', async () => {
    let c = await restart();
    expect((await signInAs('F', c)).email).toBe('f@example.test');
    chmodSync(data, 0o500); // the folder can't be changed (no new file, no rename, no delete); the file can
    try {
      expect(await c.signOut()).toMatchObject({ cleared: true, recorded: true });
      expect(readFileSync(bin).length).toBe(0);
      c = await restart();
      expect(c.status().signedIn).toBe(false);
      await expect(c.accessToken()).rejects.toThrow(/Not signed in/);
    } finally {
      chmodSync(data, 0o700);
    }
  });

  it('keeps a sign-in it couldn’t remove unused after a restart, through a marker that names it (W-185)', async () => {
    let c = await restart();
    await signInAs('G', c);
    const stored = readFileSync(bin);
    locked.add(bin); // the stored sign-in can't be replaced, removed or written; its folder can
    try {
      expect(await c.signOut()).toMatchObject({ cleared: false, recorded: true });
      expect(JSON.parse(readFileSync(marker, 'utf8')).of).toBe(sha256(stored));
      c = await restart();
      expect(readFileSync(bin)).toEqual(stored); // the old sign-in is still on disk...
      expect(c.status().signedIn).toBe(false); // ...and not used
      await expect(c.accessToken()).rejects.toThrow(/Not signed in/);
    } finally {
      locked.delete(bin);
    }
    expect(c.status().signedIn).toBe(false);
    expect(readFileSync(bin).length).toBe(0); // removed once it could be, and the marker with it
    expect(config.readJson('chatgpt-signed-out.json', 'missing')).toBeNull();
  });

  it('doesn’t take a newer sign-in for the one an old marker signed out (W-185)', async () => {
    let c = await restart();
    await signInAs('H', c);
    locked.add(bin);
    try {
      await c.signOut(); // marker written for H's sign-in
    } finally {
      locked.delete(bin);
    }
    locked.add(marker); // and it can't be removed when the user signs in again
    try {
      expect((await signInAs('I', c)).email).toBe('i@example.test');
      c = await restart();
      expect(c.status()).toMatchObject({ signedIn: true, email: 'i@example.test' });
      expect(await c.accessToken()).toBe('access-i');
    } finally {
      locked.delete(marker);
    }
    expect(c.status().email).toBe('i@example.test');
    expect(config.readJson('chatgpt-signed-out.json', 'missing')).toBeNull(); // removed once it could be
  });

  it('still honours a marker from 0.1.31, which names no sign-in (W-185)', async () => {
    let c = await restart();
    await signInAs('J', c);
    writeFileSync(marker, JSON.stringify({ at: new Date().toISOString() })); // as 0.1.31 wrote it
    c = await restart();
    expect(c.status().signedIn).toBe(false);
    await expect(c.accessToken()).rejects.toThrow(/Not signed in/);
    expect(readFileSync(bin).length).toBe(0); // removed, and the marker with it
    expect(config.readJson('chatgpt-signed-out.json', 'missing')).toBeNull();
    // Such a marker that can't be removed would also sign out the next sign-in: that one isn't kept, and says so.
    writeFileSync(marker, JSON.stringify({ at: new Date().toISOString() }));
    locked.add(marker);
    try {
      await expect(signInAs('K', c)).rejects.toThrow(/couldn’t keep this sign-in/);
      expect(readFileSync(bin).length).toBe(0);
      expect(c.status().signedIn).toBe(false);
    } finally {
      locked.delete(marker);
    }
  });
});
