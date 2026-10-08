import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The updater's download path against a fake release server: `net.fetch` is mocked, and each test
// decides how the server answers (stall, drop, ignore Range, corrupt, ...). Timers are fake, so
// the 2-minute stall timeout and the retry back-off run instantly.

type Serve = (from: number | undefined, signal: AbortSignal) => Response;
const h = vi.hoisted(() => ({
  api: 200,
  info: null as null | Record<string, unknown>,
  serve: null as null | Serve,
  requests: [] as (number | undefined)[],
  quits: 0,
  launch: 'spawn' as 'spawn' | 'error',
  launched: [] as string[],
  /** The process check (ps / CIM) fails, as on a timeout or a refused query. */
  probeFails: false,
  /** Publishing the installer's pid in the marker fails (disk error), after the installer started. */
  markerFails: false,
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.8', getPath: () => tmpdir(), quit: () => h.quits++ },
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
// The installer launch: emits 'spawn' or 'error' like a real child process would.
vi.mock('node:child_process', async (orig) => {
  const { EventEmitter } = await import('node:events');
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    execFileSync: ((...a: Parameters<typeof real.execFileSync>) => {
      if (h.probeFails) throw new Error('timed out');
      return real.execFileSync(...a);
    }) as typeof real.execFileSync,
    spawn: (cmd: string) => {
      h.launched.push(cmd);
      const child = Object.assign(new EventEmitter(), { unref: () => {}, pid: 4242 });
      setTimeout(() => (h.launch === 'spawn' ? child.emit('spawn') : child.emit('error', new Error('spawn EPERM'))), 0);
      return child;
    },
  };
});
// Writing the full marker (with the installer's pid) fails on demand.
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    writeFileSync: ((file: Parameters<typeof real.writeFileSync>[0], data: Parameters<typeof real.writeFileSync>[1], ...rest: unknown[]) => {
      if (h.markerFails && String(data).includes('"pid"')) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      return (real.writeFileSync as (...x: unknown[]) => void)(file, data, ...rest);
    }) as typeof real.writeFileSync,
    renameSync: ((from: string, to: string) => {
      if (h.markerFails && String(to).endsWith('update-pending.json') && real.readFileSync(from, 'utf8').includes('"pid"')) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      return real.renameSync(from, to);
    }) as typeof real.renameSync,
  };
});
// Manifest signatures are covered by the release tooling; here every manifest counts as signed.
vi.mock('node:crypto', async (orig) => ({ ...(await orig<typeof import('node:crypto')>()), verify: () => true }));

const { Updater } = await import('../src/main/updater');

// The updater only runs on macOS and Windows; CI runs these tests on Linux.
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeAll(() => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') Object.defineProperty(process, 'platform', { ...realPlatform, value: 'darwin' });
});
afterAll(() => Object.defineProperty(process, 'platform', realPlatform));

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
  h.quits = 0;
  h.launch = 'spawn';
  h.launched = [];
  h.probeFails = false;
  h.markerFails = false;
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

describe('Updater install handoff (W-83)', () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' }));
  afterEach(() => Object.defineProperty(process, 'platform', realPlatform));
  const ready = () => {
    mkdirSync(versionDir(), { recursive: true });
    const file = join(versionDir(), NAME);
    writeFileSync(file, BODY);
    u.state = { available: true, version: '0.1.9', ready: true, file, sha256: SHA, size: SIZE };
  };

  it('reports an installer that fails to start, without quitting', async () => {
    ready();
    h.launch = 'error';
    let resumed = 0;
    vi.useRealTimers();
    await u.install(async () => true, () => resumed++);
    expect(h.launched).toHaveLength(1);
    expect(h.quits).toBe(0);
    expect(resumed).toBe(1);
    expect(u.state.error).toMatch(/installer could not be started \(spawn EPERM\)/);
    expect(existsSync(join(dir, 'update-pending.json'))).toBe(false);
  });

  it('quits only once the installer is running, leaving a note for the next start', async () => {
    ready();
    let resumed = 0;
    vi.useRealTimers();
    await u.install(async () => true, () => resumed++);
    expect(h.quits).toBe(1);
    expect(resumed).toBe(0);
    // Which process installs, so a Wren opened again meanwhile can tell (W-96).
    const pending = JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8'));
    expect(pending).toMatchObject({ version: '0.1.9', pid: 4242 });
    expect(pending.installer).toContain(join(dir, 'install-'));
  });

  it('still hands off (and settles) when the installer\'s pid can\'t be written to the marker (W-105)', async () => {
    ready();
    h.markerFails = true;
    let resumed = 0;
    vi.useRealTimers();
    await u.install(async () => true, () => resumed++);
    expect(h.quits).toBe(1);
    expect(resumed).toBe(0);
    // The marker written before the launch still names the installer (W-109), just without its pid.
    const marker = JSON.parse(readFileSync(join(dir, 'update-pending.json'), 'utf8'));
    expect(marker).toMatchObject({ version: '0.1.9', installer: expect.stringContaining(join(dir, 'install-')) });
    expect(marker.pid).toBeUndefined();
  });

  it('at the next start, says the last install did not happen (and why), and repeats it with the next ready update', async () => {
    writeFileSync(join(dir, 'update-pending.json'), JSON.stringify({ version: '0.1.9' }));
    writeFileSync(join(dir, 'update-failed.txt'), 'the update could not be unpacked\n');
    u.cleanup();
    expect(u.state.error).toBe('The last attempt to install 0.1.9 failed (the update could not be unpacked).');
    expect(existsSync(join(dir, 'update-pending.json'))).toBe(false);
    expect(existsSync(join(dir, 'update-failed.txt'))).toBe(false);
    await u.check();
    await done();
    expect(u.state).toMatchObject({ ready: true, error: 'The last attempt to install 0.1.9 failed (the update could not be unpacked).' });
  });

  it('says nothing when the installed version is the one that was pending', async () => {
    writeFileSync(join(dir, 'update-pending.json'), JSON.stringify({ version: '0.1.8' }));
    u.cleanup();
    expect(u.state.error).toBeUndefined();
    expect(existsSync(join(dir, 'update-pending.json'))).toBe(false);
  });
});

// W-96: Wren opened again while the installer is still swapping the app must leave its files alone.
// (The liveness check runs `ps` here; on Windows it asks CIM, which the self-test covers.)
describe.skipIf(process.platform === 'win32')('Updater reopened mid-install (W-96)', () => {
  it('leaves an install that is still running alone, and reports it once it has ended', async () => {
    const { spawn: realSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const staging = join(dir, 'install-abc');
    mkdirSync(join(staging, 'staging'), { recursive: true });
    const script = join(staging, 'install.sh');
    writeFileSync(script, 'sleep 30\n');
    const child = realSpawn('/bin/bash', [script], { stdio: 'ignore' }) // as install() starts it;
    await new Promise((r) => child.once('spawn', r));
    try {
      writeFileSync(join(dir, 'update-pending.json'), JSON.stringify({ version: '0.1.9', pid: child.pid, installer: script, at: Date.now() }));
      expect(u.installerRunning()).toBe(true);
      u.cleanup();
      expect(existsSync(join(staging, 'staging'))).toBe(true);
      expect(existsSync(join(dir, 'update-pending.json'))).toBe(true);
      expect(u.state.error).toBeUndefined();
    } finally {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
    expect(u.installerRunning()).toBe(false);
    u.cleanup();
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(join(dir, 'update-pending.json'))).toBe(false);
    expect(u.state.error).toMatch(/last attempt to install 0\.1\.9 failed/);
  });

  it('keeps the install\'s files when the process check fails for a live pid (W-104)', async () => {
    const { spawn: realSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const staging = join(dir, 'install-def');
    mkdirSync(staging, { recursive: true });
    const script = join(staging, 'install.sh');
    writeFileSync(script, 'sleep 30\n');
    const child = realSpawn('/bin/bash', [script], { stdio: 'ignore' }) // as install() starts it;
    await new Promise((r) => child.once('spawn', r));
    try {
      writeFileSync(join(dir, 'update-pending.json'), JSON.stringify({ version: '0.1.9', pid: child.pid, installer: script, at: Date.now() }));
      h.probeFails = true;
      expect(u.installerState()).toBe('unknown');
      expect(u.installerRunning()).toBe(true);
      u.cleanup();
      expect(existsSync(staging)).toBe(true);
      expect(existsSync(join(dir, 'update-pending.json'))).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
    // Once the process is gone a failing check doesn't matter any more.
    expect(u.installerState()).toBe('gone');
  });

  it('recognises an installer whose pid was never recorded, by its script (W-109)', async () => {
    const { spawn: realSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const staging = join(dir, 'install-ghi');
    mkdirSync(staging, { recursive: true });
    const script = join(staging, 'install.sh');
    writeFileSync(script, 'sleep 30\n');
    writeFileSync(join(dir, 'update-pending.json'), JSON.stringify({ version: '0.1.9', installer: script, at: Date.now() }));
    expect(u.installerState()).toBe('gone'); // not started (yet)
    // Something that only mentions the script isn't the installer (W-120).
    const viewer = realSpawn('/bin/sh', ['-c', `sleep 30 # ${script}`], { stdio: 'ignore' });
    const tail = realSpawn('/usr/bin/tail', ['-f', script], { stdio: 'ignore' });
    await Promise.all([viewer, tail].map((c) => new Promise((r) => c.once('spawn', r))));
    expect(u.installerState()).toBe('gone');
    viewer.kill('SIGKILL');
    tail.kill('SIGKILL');
    // Started the way install() starts it.
    const child = realSpawn('/bin/bash', [script, '123', 'more args'], { stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    try {
      expect(u.installerState()).toBe('running');
      u.cleanup();
      expect(existsSync(staging)).toBe(true);
      h.probeFails = true;
      expect(u.installerState()).toBe('unknown');
      h.probeFails = false;
    } finally {
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
    }
    expect(u.installerState()).toBe('gone');
    u.cleanup();
    expect(existsSync(staging)).toBe(false);
  });

  it('does not mistake another process (a reused pid) or an old marker for the installer', async () => {
    mkdirSync(join(dir, 'install-xyz'), { recursive: true });
    const script = join(dir, 'install-xyz', 'install.sh');
    // This test's own process is alive, but it isn't that installer.
    writeFileSync(join(dir, 'update-pending.json'), JSON.stringify({ version: '0.1.8', pid: process.pid, installer: script, at: Date.now() }));
    expect(u.installerRunning()).toBe(false);
    writeFileSync(join(dir, 'update-pending.json'), JSON.stringify({ version: '0.1.8', pid: process.pid, installer: process.argv[1] ?? 'node', at: Date.now() - 31 * 60_000 }));
    expect(u.installerRunning()).toBe(false);
    u.cleanup();
    expect(existsSync(join(dir, 'install-xyz'))).toBe(false);
  });

});
