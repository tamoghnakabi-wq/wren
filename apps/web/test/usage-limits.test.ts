import { describe, expect, it, vi } from 'vitest';

// Resuming after a plan's usage limit: when a task carries on by itself, and what a computer reports about a
// limit is checked before it is kept. The pure parts of lib/runs.ts (the database parts: usage-limits.db.test.ts).
vi.mock('../src/lib/db', () => ({ db: () => ({}) }));
vi.mock('../src/lib/notify', () => ({ notifyUser: async () => true, nudgeDevice: async () => {} }));
vi.mock('../src/lib/runner/sandbox-host', () => ({ SandboxHost: class {} }));
const { cleanLimit, formatWhen, limitWake, LIMIT_HORIZON_MS, MAX_LIMIT_RESUMES } = await import('../src/lib/runs');

const now = Date.UTC(2026, 10, 15, 3, 0); // 15 Nov 2026, 2 pm in Melbourne
const on = { enabled: true, userPaused: false, earlier: 0, now, jitter: 0 };

describe('when a task paused by a usage limit carries on', () => {
  it('a minute after the reset, at least five minutes from now', () => {
    expect(limitWake(now + 3_600_000, on)?.getTime()).toBe(now + 3_660_000);
    expect(limitWake(now + 30_000, on)?.getTime()).toBe(now + 300_000);
    expect(limitWake(now - 60_000, on)?.getTime()).toBe(now + 300_000); // already reset
    expect(limitWake(now + 3_600_000, { ...on, jitter: 42_000 })?.getTime()).toBe(now + 3_702_000);
  });

  it('never when the user turned it off or paused the task, the reset is unknown or a day away, or it already carried on enough', () => {
    expect(limitWake(now + 3_600_000, { ...on, enabled: false })).toBeNull();
    expect(limitWake(now + 3_600_000, { ...on, userPaused: true })).toBeNull();
    expect(limitWake(undefined, on)).toBeNull();
    expect(limitWake(now + LIMIT_HORIZON_MS + 1, on)).toBeNull(); // a weekly limit waits for the user
    expect(limitWake(now + LIMIT_HORIZON_MS, on)).not.toBeNull();
    expect(limitWake(now + 3_600_000, { ...on, earlier: MAX_LIMIT_RESUMES })).toBeNull();
    expect(limitWake(now + 3_600_000, { ...on, earlier: MAX_LIMIT_RESUMES - 1 })).not.toBeNull();
  });
});

describe('a limit as a computer reports it', () => {
  it('is clipped and its reset kept only when plausible', () => {
    const t = Date.now();
    expect(cleanLimit({ error: 'x'.repeat(5000), code: 'c'.repeat(200), resetAt: t + 3_600_000, midTurn: true })).toEqual({ error: 'x'.repeat(1500), code: 'c'.repeat(80), resetAt: t + 3_600_000, midTurn: true });
    expect(cleanLimit({ error: 'e', resetAt: t + 30 * 86_400_000 })).toEqual({ error: 'e' }); // a month away: not believed
    expect(cleanLimit({ error: 'e', resetAt: 'soon', midTurn: 'yes' })).toEqual({ error: 'e' });
    expect(cleanLimit({ code: 7 })).toEqual({ error: 'A usage limit was reached.' });
    expect(cleanLimit(undefined)).toBeUndefined();
    expect(cleanLimit('limit')).toBeUndefined();
  });
});

describe('times in notifications', () => {
  it('say today, tomorrow or the day, in the account’s time zone', () => {
    expect(formatWhen(now + 2 * 3_600_000, 'Australia/Melbourne', now)).toBe('at 4:00 pm');
    expect(formatWhen(now + 20 * 3_600_000, 'Australia/Melbourne', now)).toBe('tomorrow at 10:00 am');
    expect(formatWhen(now + 3 * 86_400_000, 'Australia/Melbourne', now)).toBe('on Wed 18 Nov at 2:00 pm');
    expect(formatWhen(now, 'Not/AZone', now)).toBe('at 3:00 am'); // an unknown zone reads as UTC
  });
});
