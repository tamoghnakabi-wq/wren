import { beforeEach, describe, expect, it, vi } from 'vitest';

// Due schedules are claimed in one transaction that moves each to its next time. One whose next time
// couldn't be worked out threw there, which failed the whole step every minute: nobody's schedules ran.
// It is now switched off and its owner told, and the others start.

const h = vi.hoisted(() => ({
  due: [] as { id: string; user_id: string; agent_id: string; name: string; prompt: string; cron: string; timezone: string; next_run_at: string }[],
  updates: [] as { id: string; text: string }[],
  started: [] as string[],
  notified: [] as { userId: string; title: string }[],
}));

vi.mock('@/lib/db', () => {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    if (text.startsWith('select * from public.schedules where enabled')) return Promise.resolve(h.due);
    if (text.startsWith('update public.schedules set')) h.updates.push({ id: String(values[values.length - 1]), text });
    return Promise.resolve([]);
  };
  return { db: () => Object.assign(tag, { begin: async <T>(fn: (tx: typeof tag) => Promise<T>) => fn(tag) }) };
});
vi.mock('@/lib/auth', () => ({ HttpError: class extends Error {} }));
vi.mock('@/lib/crypto', () => ({ safeEqual: (a: string, b: string) => a === b }));
vi.mock('@/lib/env', () => ({ env: { cronSecret: 'test-cron-secret' } }));
vi.mock('@/lib/http', () => ({ json: (b: unknown, status = 200) => new Response(JSON.stringify(b), { status }), route: (fn: unknown) => fn }));
vi.mock('@/lib/notify', () => ({ notifyUser: async (n: { userId: string; title: string }) => void h.notified.push({ userId: n.userId, title: n.title }) }));
vi.mock('@/lib/schedules', () => ({
  nextRunAfter: (cron: string) => {
    if (cron === 'broken') throw new Error('Invalid schedule: unhandled timestamp');
    return new Date('2027-01-01T00:00:00Z');
  },
}));
vi.mock('@/lib/runs', () => ({
  kickTick: async () => {},
  kickRun: async () => {},
  cleanUpCloudRun: async () => true,
  startTask: async (t: { scheduleId: string }) => (h.started.push(t.scheduleId), { sessionId: `session-of-${t.scheduleId}` }),
  endRemovedAgentRuns: async () => 0,
  resumeLimitedRuns: async () => 0,
  tidyAsks: async () => ({ woken: 0, stopped: 0 }),
}));
vi.mock('@/lib/devices', () => ({ revokeUnclaimedDevices: async () => 0, endOrphanedRuns: async () => 0 }));
vi.mock('@/lib/cleanup', () => ({ runCleanups: async () => 0 }));
const { POST } = (await import('../src/app/api/internal/cron/route')) as unknown as { POST: (req: Request) => Promise<Response> };
const call = async () => (await POST(new Request('http://x/api/internal/cron', { method: 'POST', headers: { authorization: 'Bearer test-cron-secret' } }))).json();

const schedule = (id: string, cron = '0 8 * * *') => ({ id, user_id: `owner-of-${id}`, agent_id: 'agent', name: `Schedule ${id}`, prompt: 'go', cron, timezone: 'UTC', next_run_at: '2026-11-10T08:00:00Z' });

beforeEach(() => {
  h.due = [];
  h.updates.length = h.started.length = h.notified.length = 0;
});

describe('due schedules', () => {
  it('start, each moved to its next time first', async () => {
    h.due = [schedule('a'), schedule('b')];
    const report = await call();
    expect(report.scheduled).toBe(2);
    expect(h.started).toEqual(['a', 'b']);
    expect(report.errors).toEqual([]);
  });

  it('one whose next time can’t be worked out is switched off and its owner told; the others still start', async () => {
    h.due = [schedule('a'), schedule('bad', 'broken'), schedule('c')];
    const report = await call();
    expect(h.started).toEqual(['a', 'c']);
    expect(report.scheduled).toBe(2);
    expect(h.updates.find((u) => u.id === 'bad')?.text).toContain('enabled = false');
    expect(h.notified).toEqual([{ userId: 'owner-of-bad', title: 'Scheduled task "Schedule bad" was switched off' }]);
    expect(report.errors).toEqual(['schedule "Schedule bad": Invalid schedule: unhandled timestamp']);
  });
});
