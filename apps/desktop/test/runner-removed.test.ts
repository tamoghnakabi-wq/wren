import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

const saved: unknown[] = [];
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, dialog: {}, Notification: { isSupported: () => false }, safeStorage: {}, desktopCapturer: {}, screen: {} }));
let token = 'tok-old';
vi.mock('../src/main/config', async (orig) => ({
  ...(await orig<typeof import('../src/main/config')>()),
  loadDevice: () => (token ? { token, deviceId: 'd', channel: 'c', supabase: { url: 'u', key: 'k' }, appUrl: 'x' } : null),
  saveDevice: (d: unknown) => {
    saved.push(d);
    if (d === null) token = '';
  },
  loadPolicy: () => ({ folders: [], shell: false, browser: false, screen: false, remoteApprovals: true, localModelUrl: '', launchAtLogin: false }),
}));
vi.mock('../src/main/capabilities', () => ({ detect: async () => ({}) }));
let onHeartbeat: () => void = () => {};
vi.mock('../src/main/api', async (orig) => {
  const real = await orig<typeof import('../src/main/api')>();
  return {
    ...real,
    deviceJson: async () => {
      onHeartbeat();
      throw new real.ApiError('This device is not linked or was removed.', 401, 'device_revoked');
    },
  };
});
const { DeviceRunner } = await import('../src/main/runner');

// W-149: removed from the account on the web, the computer stops its tasks, not just its polling.
describe('a computer removed from the account', () => {
  it('stops its running tasks and drops the dead sign-in', async () => {
    const runner = new DeviceRunner(() => {}, () => {});
    const task = new AbortController();
    (runner as unknown as { active: Map<string, AbortController> }).active.set('run-1', task);
    await runner.tick();
    expect(task.signal.aborted).toBe(true);
    expect(saved).toEqual([null]);
  });

  it('leaves a link made while the request was out alone', async () => {
    token = 'tok-old';
    saved.length = 0;
    const runner = new DeviceRunner(() => {}, () => {});
    const task = new AbortController();
    (runner as unknown as { active: Map<string, AbortController> }).active.set('run-2', task);
    onHeartbeat = () => (token = 'tok-new'); // linked again meanwhile
    await runner.tick();
    expect(task.signal.aborted).toBe(false);
    expect(saved).toEqual([]);
  });
});
