import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The cron route with every stage mocked: it must answer within its deadline whatever hangs.
let staleRuns: { id: string }[] = [];
const sqlTag = (strings: TemplateStringsArray) => {
  const text = strings.join('?').replace(/\s+/g, ' ');
  return Promise.resolve(text.includes("runtime = 'cloud' and status in ('queued', 'running')") ? staleRuns : []);
};
vi.mock('@/lib/db', () => ({ db: () => Object.assign(sqlTag, { begin: async () => [] }) }));
vi.mock('@/lib/auth', () => ({ HttpError: class extends Error {} }));
vi.mock('@/lib/crypto', () => ({ safeEqual: (a: string, b: string) => a === b }));
vi.mock('@/lib/env', () => ({ env: { cronSecret: 'test-cron-secret' } }));
vi.mock('@/lib/http', () => ({ json: (b: unknown, status = 200) => new Response(JSON.stringify(b), { status }), route: (fn: unknown) => fn }));
vi.mock('@/lib/notify', () => ({ notifyUser: async () => {} }));
vi.mock('@/lib/schedules', () => ({ nextRunAfter: () => new Date() }));
const calls: Record<string, unknown[]> = {};
const record = (name: string, value: unknown) => async (...args: unknown[]) => ((calls[name] = args), value);
let kick: () => Promise<void> = async () => {};
vi.mock('@/lib/runs', () => ({
  kickTick: () => kick(),
  kickRun: async () => {},
  cleanUpCloudRun: async () => true,
  startTask: async () => ({ sessionId: 's' }),
  endRemovedAgentRuns: (...a: unknown[]) => record('removed', 0)(...a),
}));
vi.mock('@/lib/devices', () => ({
  revokeUnclaimedDevices: (...a: unknown[]) => record('unclaimed', 0)(...a),
  endOrphanedRuns: (...a: unknown[]) => record('orphaned', 0)(...a),
}));
vi.mock('@/lib/cleanup', () => ({ runCleanups: (...a: unknown[]) => record('deletions', 0)(...a) }));
const { POST } = (await import('../src/app/api/internal/cron/route')) as unknown as { POST: (req: Request) => Promise<Response> };
const call = () => POST(new Request('http://x/api/internal/cron', { method: 'POST', headers: { authorization: 'Bearer test-cron-secret' } }));

beforeEach(() => {
  staleRuns = [];
  kick = async () => {};
  for (const k of Object.keys(calls)) delete calls[k];
});
afterEach(() => vi.useRealTimers());

describe('cron deadline', () => {
  it('answers by its deadline when a stage hangs, and names what it skipped', async () => {
    vi.useFakeTimers();
    staleRuns = [{ id: 'r1' }];
    kick = () => new Promise(() => {}); // never answers
    const res = call();
    await vi.advanceTimersByTimeAsync(45_000);
    const report = await (await res).json();
    expect(report.skipped).toEqual(['schedules', 'approvals', 'unclaimed', 'orphaned', 'removed', 'cleanup', 'deletions']);
    expect(report.kicked).toBe(1);
    expect(calls.deletions).toBeUndefined();
  });

  it('runs every stage when there is time, handing each its share of the deadline', async () => {
    const before = Date.now();
    const report = await (await call()).json();
    expect(report.skipped).toEqual([]);
    for (const name of ['unclaimed', 'removed']) {
      const until = calls[name][0] as number;
      expect(until, name).toBeGreaterThan(before);
      expect(until, name).toBeLessThanOrEqual(before + 45_000 + 1000);
    }
    expect(calls.orphaned[1]).toBe(calls.removed[0]);
    const [limit, budget] = calls.deletions as number[];
    expect(limit).toBe(10);
    expect(budget).toBeGreaterThan(30_000);
    expect(budget).toBeLessThanOrEqual(35_000);
  });
});
