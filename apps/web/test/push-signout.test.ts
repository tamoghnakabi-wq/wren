import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// W-199, the browser's side: signing out removes this browser's push subscription from the account,
// ends it here and closes what it already shows, without letting a registration still on its way add
// it back, and without holding sign-out up when the server doesn't answer.

const log: string[] = [];
let releasePost: (() => void) | null = null;
const api = vi.fn(async (path: string, opts?: { body?: unknown }) => {
  if (path === '/api/push/subscribe' && opts?.body) {
    await new Promise<void>((r) => (releasePost = r));
    log.push('register');
  }
  return { ok: true };
});
vi.mock('@/lib/client/api', () => ({ api: (path: string, opts?: { body?: unknown }) => api(path, opts) }));
vi.mock('@/lib/client/desktop', () => ({ desktop: () => null }));
vi.mock('../src/components/ui', () => ({ Button: () => null }));

const { enablePush, forgetPushHere } = await import('../src/components/app/push');

const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', unsubscribe: vi.fn(async () => (log.push('unsubscribe'), true)), toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'k', auth: 'a' } }) };
const shown = [{ close: vi.fn(() => log.push('close 1')) }, { close: vi.fn(() => log.push('close 2')) }];
const reg = {
  pushManager: { getSubscription: async () => sub, subscribe: async () => sub },
  getNotifications: async () => shown,
};
let fetchImpl: (url: string, init: RequestInit) => Promise<Response>;

beforeEach(() => {
  log.length = 0;
  releasePost = null;
  vi.clearAllMocks();
  fetchImpl = async (url, init) => {
    log.push(`${init.method} ${url} ${init.body}`);
    return new Response('{"ok":true}');
  };
  vi.stubGlobal('navigator', {
    userAgent: 'Test',
    serviceWorker: { register: async () => reg, ready: Promise.resolve(reg), getRegistration: async () => reg },
  });
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: async () => 'granted' });
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => fetchImpl(url, init));
  vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'BElpdGVzdGtleQ');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('signing out of a browser with notifications on (W-199)', () => {
  it('removes the subscription from the account first, then ends it here and closes what it shows', async () => {
    await forgetPushHere();
    expect(log).toEqual([`DELETE /api/push/subscribe ${JSON.stringify({ endpoint: sub.endpoint })}`, 'unsubscribe', 'close 1', 'close 2']);
  });

  it('with no sign-in to ask with (the sign-in page), only ends it here', async () => {
    await forgetPushHere({ local: true });
    expect(log).toEqual(['unsubscribe', 'close 1', 'close 2']);
  });

  it('waits for a registration still on its way, so it cannot add the subscription back afterwards', async () => {
    const registering = enablePush();
    await vi.waitFor(() => expect(releasePost).not.toBeNull());
    const signingOut = forgetPushHere();
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual([]);
    releasePost!();
    await registering;
    await signingOut;
    expect(log).toEqual(['register', `DELETE /api/push/subscribe ${JSON.stringify({ endpoint: sub.endpoint })}`, 'unsubscribe', 'close 1', 'close 2']);
  });

  it('does not hold sign-out up when the server never answers', async () => {
    vi.useFakeTimers();
    fetchImpl = () => new Promise<Response>(() => {});
    const signingOut = forgetPushHere();
    await vi.advanceTimersByTimeAsync(5_000);
    await signingOut;
    expect(log).toEqual(['unsubscribe', 'close 1', 'close 2']);
  });

  it('never throws, even when the browser refuses everything', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => Promise.reject(new Error('blocked')) } });
    await expect(forgetPushHere()).resolves.toBeUndefined();
  });
});
