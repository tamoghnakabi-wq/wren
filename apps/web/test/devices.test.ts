import { describe, expect, it, vi } from 'vitest';

// revokeDevice from the cron carries the cron's deadline into ending the device's tasks.
const finished: string[] = [];
const fakeSql = (strings: TemplateStringsArray) => {
  const text = strings.join('?').replace(/\s+/g, ' ').trim();
  if (text.startsWith('select r.id from public.runs')) return Promise.resolve([{ id: 'run-1' }, { id: 'run-2' }]);
  if (text.startsWith('select id from public.devices')) return Promise.resolve([{ id: 'dev-1' }]);
  return Promise.resolve([{ id: 'dev-1' }]);
};
vi.mock('../src/lib/db', () => ({ db: () => fakeSql }));
vi.mock('../src/lib/runs', () => ({
  taskTx: (fn: (tx: typeof fakeSql) => unknown) => fn(fakeSql),
  finishRun: async (id: string) => (finished.push(id), 'ended'),
}));
const { revokeDevice, revokeUnclaimedDevices } = await import('../src/lib/devices');

describe('unlinking with a deadline', () => {
  it('ends the device’s tasks when there is time, and starts none after the deadline', async () => {
    expect(await revokeDevice('dev-1')).toBe(true);
    expect(finished).toEqual(['run-1', 'run-2']);
    finished.length = 0;
    expect(await revokeDevice('dev-1', { until: Date.now() - 1 })).toBe(true);
    expect(finished).toEqual([]);
    // From the cron's unclaimed-device backstop too.
    expect(await revokeUnclaimedDevices(Date.now() - 1)).toBe(0);
    expect(await revokeUnclaimedDevices(Date.now() + 10_000)).toBe(1);
    expect(finished).toEqual(['run-1', 'run-2']);
  });
});
