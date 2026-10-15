import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Sign in with ChatGPT, against stand-ins: a fake browser (the authorize URL is opened by the test, which
// then calls the loopback callback), a fake token endpoint and ID-token check, and pass-through
// "encryption". No network and no real keychain.
const data = mkdtempSync(join(tmpdir(), 'wren-chatgpt-'));
process.env.WREN_DATA_DIR = data;
const opened: string[] = [];
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

afterEach(() => chmodSync(data, 0o700));

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

  it("never uses a sign-in it couldn't remove at sign-out, and removes it once it can (W-185)", async () => {
    expect(chatgpt.status().signedIn).toBe(true);
    chmodSync(data, 0o500); // the data folder can't be written: the stored sign-in can't be emptied or deleted
    const out = await chatgpt.signOut();
    expect(out.cleared).toBe(false);
    expect(readFileSync(join(data, 'chatgpt.bin')).length).toBeGreaterThan(0); // still on disk...
    expect(chatgpt.status().signedIn).toBe(false); // ...but not used
    await expect(chatgpt.accessToken()).rejects.toThrow(/Not signed in/);
    chmodSync(data, 0o700);
    expect(chatgpt.status().signedIn).toBe(false);
    expect(readFileSync(join(data, 'chatgpt.bin')).length).toBe(0); // removed at the first chance
    expect(config.readSecret('chatgpt.bin')).toBeNull();
  });
});
