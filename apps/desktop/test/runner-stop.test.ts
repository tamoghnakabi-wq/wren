import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A desktop run the user stops (round 29): the keepalive sees the Stop and aborts the run's signal, which cuts
// a model call short. The loop reports that as a failure; the run must still end cancelled, as the user asked.
const finished: unknown[] = [];
let cancel = false;
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, dialog: {}, Notification: { isSupported: () => false }, safeStorage: {}, desktopCapturer: {}, screen: {} }));
vi.mock('../src/main/config', async (orig) => ({
  ...(await orig<typeof import('../src/main/config')>()),
  loadDevice: () => ({ token: 't', deviceId: 'd', channel: 'c', supabase: { url: 'u', key: 'k' }, appUrl: 'x' }),
  loadPolicy: () => ({ folders: [], shell: false, browser: false, screen: false, remoteApprovals: true, localModelUrl: '', launchAtLogin: false }),
}));
vi.mock('../src/main/capabilities', () => ({ detect: async () => ({}) }));
vi.mock('../src/main/host', async (orig) => ({ ...(await orig<typeof import('../src/main/host')>()), closeRunTab: async () => {}, killRunJobs: () => {} }));
vi.mock('../src/main/api', async (orig) => {
  const real = await orig<typeof import('../src/main/api')>();
  return {
    ...real,
    deviceJson: async (path: string, body: unknown) => {
      if (path.endsWith('/claim')) return { claimed: true, leaseId: 'lease-1', run: { id: 'run-1', model: { source: 'openai' } } };
      if (path.endsWith('/control')) return { cancel, pause: false };
      if (path.endsWith('/finish')) return void finished.push(body);
      return {};
    },
  };
});
const { DeviceRunner } = await import('../src/main/runner');

afterEach(() => {
  vi.useRealTimers();
  finished.length = 0;
  cancel = false;
});

describe('a desktop run the user stops', () => {
  it('ends cancelled even when the model call it cut short reports a failure', async () => {
    vi.useFakeTimers();
    const runner = new DeviceRunner(() => {}, () => {});
    // The loop: waits on a model call until the run's signal aborts, then reports what an aborted request does.
    (runner as unknown as { runAgentLoop: (...a: unknown[]) => Promise<unknown> }).runAgentLoop = (_c, _s, _p, _settings, signal) =>
      new Promise((r) => (signal as AbortSignal).addEventListener('abort', () => r({ kind: 'failed', error: 'Request aborted.', steps: 1 }), { once: true }));
    const done = (runner as unknown as { execute: (id: string, s: unknown) => Promise<void> }).execute('run-1', {});
    cancel = true; // the user pressed Stop
    await vi.advanceTimersByTimeAsync(46_000); // the keepalive looks
    await done;
    expect(finished).toEqual([{ kind: 'cancelled', steps: 1 }]);
  });

  it('keeps a real failure when nobody pressed Stop', async () => {
    const runner = new DeviceRunner(() => {}, () => {});
    (runner as unknown as { runAgentLoop: (...a: unknown[]) => Promise<unknown> }).runAgentLoop = async () => ({ kind: 'failed', error: 'The model is unavailable.', steps: 2 });
    await (runner as unknown as { execute: (id: string, s: unknown) => Promise<void> }).execute('run-1', {});
    expect(finished).toEqual([{ kind: 'failed', error: 'The model is unavailable.', steps: 2 }]);
  });
});
