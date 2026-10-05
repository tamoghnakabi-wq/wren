import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The updater's download path against a fake release server: `net.fetch` is mocked, and each test
// decides how the server answers (stall, drop, ignore Range, corrupt, ...). Timers are fake, so
// the 2-minute stall timeout and the retry back-off run instantly.

type Serve = (from: number | undefined, signal: AbortSignal) => Response;
const h = vi.hoisted(() => ({
  api: 200,
  info: null as null | Record<string, unknown>,
  serve: null as null | Serve,
  requests: [] as (number | undefined)[],
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.8', getPath: () => tmpdir() },
  safeStorage: {},
  net: {
    fetch: async (url: string, init: RequestInit = {}) => {
      if (url.includes('/api/updates')) return h.api !== 200 ? new Response(null, { status: h.api }) : h.info ? Response.json(h.info) : new Response(null, { status: 204 });
      const range = /^bytes=(\d+)-$/.exec(new Headers(init.headers).get('range') ?? '')?.[1];
      const from = range === undefined ? undefined : Number(range);
      h.requests.push(from);
      return h.serve!(from, init.signal!);
    },
  },
}));
// Manifest signatures are covered by the release tooling; here every manifest counts as signed.
vi.mock('node:crypto', async (orig) => ({ ...(await orig<typeof import('node:crypto')>()), verify: () => true }));

const { Updater } = await import('../src/main/updater');

const SIZE = 1_000_000;
const BODY = Buffer.from(Array.from({ length: SIZE }, (_, i) => (i * 31 + (i >> 8)) & 255));
const SHA = createHash('sha256').update(BODY).digest('hex');
const NAME = 'Wren-0.1.9-win-x64-setup.exe';

/** Stream `bytes` in 64 KB chunks. `stallAfter` stops sending without closing; `closeAfter` ends early. */
function respond(bytes: Buffer, signal: AbortSignal, opts: { status?: number; from?: number; stallAfter?: number; closeAfter?: number } = {}) {
  const { status = 200, from = 0, stallAfter, closeAfter } = opts;
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      signal.addEventListener('abort', () => c.error(new DOMException('The operation was aborted', 'AbortError')));
    },
    pull(c) {
      if (stallAfter !== undefined && sent >= stallAfter) return new Promise<void>(() => {});
      if (sent >= bytes.length || (closeAfter !== undefined && sent >= closeAfter)) return c.close();
      const chunk = bytes.subarray(sent, sent + 64 * 1024);
      sent += chunk.length;
      c.enqueue(chunk);
    },
  });
  const headers: Record<string, string> = status === 206 ? { 'content-range': `bytes ${from}-${SIZE - 1}/${SIZE}` } : {};
  return new Response(body, { status, headers });
}

/** A well-behaved server: honours Range with 206. */
const good: Serve = (from, signal) => (from ? respond(BODY.subarray(from), signal, { status: 206, from }) : respond(BODY, signal));

let dir: string;
let changes = 0;
let u: InstanceType<typeof Updater>;
const versionDir = () => join(dir, 'updates', '0.1.9');
/** Wait (in real time, without moving the fake clock) until `cond` holds. */
async function until(cond: () => boolean) {
  const end = performance.now() + 5000;
  while (!cond() && performance.now() < end) await new Promise((r) => setImmediate(r));
  expect(cond()).toBe(true);
}
const done = () => until(() => !u.state.downloading);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  dir = mkdtempSync(join(tmpdir(), 'wren-upd-'));
  process.env.WREN_DATA_DIR = dir;
  h.api = 200;
  h.info = { version: '0.1.9', url: `https://github.com/o/r/releases/download/v0.1.9/${NAME}`, sha256: SHA, size: SIZE, signature: 'x' };
  h.serve = good;
  h.requests = [];
  changes = 0;
  u = new Updater(() => changes++);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('Updater download', () => {
  it('returns as soon as a download starts, reports progress, and ends ready', async () => {
    const first = await u.check();
    expect(first).toMatchObject({ available: true, version: '0.1.9', downloading: true, received: 0, total: SIZE });
    await done();
    expect(u.state).toMatchObject({ available: true, version: '0.1.9', ready: true, sha256: SHA, size: SIZE });
    expect(readFileSync(u.state.file!).equals(BODY)).toBe(true);
    expect(readdirSync(versionDir())).toEqual([NAME]); // no .part left behind
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it('drops a stalled download after 2 minutes and resumes it from where it stopped', async () => {
    h.serve = (from, signal) => respond(BODY, signal, { stallAfter: 400_000 });
    await u.check();
    await until(() => (u.state.received ?? 0) >= 400_000);
    const have = u.state.received!;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await done();
    expect(u.state).toMatchObject({ available: true, version: '0.1.9', downloading: false });
    expect(u.state.error).toMatch(/stopped receiving data/);
    expect(u.state.retryAt).toBe(Date.now() + 5 * 60_000);

    h.serve = good;
    await vi.advanceTimersByTimeAsync(5 * 60_000); // the scheduled retry
    await done();
    expect(h.requests).toEqual([undefined, have]);
    expect(u.state.ready).toBe(true);
    expect(readFileSync(u.state.file!).equals(BODY)).toBe(true);
  });

  it('resumes after the connection closes early', async () => {
    h.serve = (from, signal) => respond(BODY, signal, { closeAfter: 300_000 });
    await u.check();
    await done();
    expect(u.state.error).toMatch(/closed before the download finished/);
    h.serve = good;
    await u.check(); // "Try again"
    await done();
    expect(h.requests[1]).toBeGreaterThanOrEqual(300_000);
    expect(readFileSync(u.state.file!).equals(BODY)).toBe(true);
  });

  it('starts over when the server ignores the Range header', async () => {
    h.serve = (from, signal) => respond(BODY, signal, { closeAfter: 300_000 });
    await u.check();
    await done();
    h.serve = (from, signal) => respond(BODY, signal); // always 200 with the whole file
    await u.check();
    await done();
    expect(h.requests[1]).toBeGreaterThan(0);
    expect(u.state.ready).toBe(true);
    expect(readFileSync(u.state.file!).equals(BODY)).toBe(true);
  });

  it('throws away a corrupt download and backs off before retrying', async () => {
    const bad = Buffer.from(BODY);
    bad[123_456] ^= 1;
    h.serve = (from, signal) => respond(bad, signal);
    await u.check();
    await done();
    expect(u.state.error).toMatch(/did not match its signed checksum/);
    expect(readdirSync(versionDir())).toEqual([]);
    expect(u.state.retryAt).toBe(Date.now() + 5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await done();
    expect(h.requests).toEqual([undefined, undefined]); // nothing kept to resume from
    expect(u.state.retryAt).toBe(Date.now() + 15 * 60_000);
  });

  it('never takes more bytes than the signed size', async () => {
    h.serve = (from, signal) => respond(Buffer.concat([BODY, Buffer.alloc(100_000)]), signal);
    await u.check();
    await done();
    expect(u.state.error).toMatch(/larger than the signed update/);
    expect(readdirSync(versionDir())).toEqual([]);
  });

  it('shows an HTTP failure as an error on the available update', async () => {
    h.serve = (from, signal) => new Response('nope', { status: 403 });
    await u.check();
    await done();
    expect(u.state).toEqual({ available: true, version: '0.1.9', downloading: false, error: 'Download failed (403)', retryAt: Date.now() + 5 * 60_000 });
  });

  it('reuses a finished download from an earlier session', async () => {
    mkdirSync(versionDir(), { recursive: true });
    writeFileSync(join(versionDir(), NAME), BODY);
    await u.check();
    await done();
    expect(h.requests).toEqual([]);
    expect(u.state.ready).toBe(true);
  });

  it('reports a failed check without claiming an update', async () => {
    h.api = 503;
    const s = await u.check();
    expect(s).toEqual({ available: false, error: 'Update check failed (503)', retryAt: Date.now() + 5 * 60_000 });
    expect(existsSync(join(dir, 'updates'))).toBe(false);
  });
});
