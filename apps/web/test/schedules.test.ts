import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/auth', () => ({
  HttpError: class HttpError extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  },
}));
const { nextRunAfter, validateCron } = await import('../src/lib/schedules');

// W-85: the 15-minute minimum holds for every gap, and again when a schedule runs.
describe('schedules', () => {
  it('rejects an expression with any gap under 15 minutes, whenever it is saved', () => {
    // Just after midnight UTC the next two runs (00:01, 12:00) look far apart; 12:00 -> 12:01 isn't.
    expect(() => validateCron('0,1 0,12 * * *', 'UTC', new Date('2026-10-06T00:00:30Z'))).toThrow(/at most every 15 minutes/);
    expect(() => validateCron('0,1 0,12 * * *', 'UTC', new Date('2026-10-06T06:00:00Z'))).toThrow(/at most every 15 minutes/);
    // Only on the 1st of the month, two minutes apart: found further ahead.
    expect(() => validateCron('0,2 9 1 * *', 'UTC', new Date('2026-10-06T00:00:00Z'))).toThrow(/at most every 15 minutes/);
  });
  it('accepts ordinary schedules', () => {
    for (const c of ['*/15 * * * *', '0 9 * * 1-5', '30 7 * * *', '0 */6 * * *', '0 9 1 * *']) expect(() => validateCron(c, 'Australia/Melbourne')).not.toThrow();
  });
  it('spaces runs at least 15 minutes apart when it runs them', () => {
    const slot = new Date('2026-10-06T12:00:00Z');
    // On time, a quarter-hourly schedule keeps its rhythm.
    expect(nextRunAfter('*/15 * * * *', 'UTC', slot, new Date('2026-10-06T12:00:05Z')).toISOString()).toBe('2026-10-06T12:15:00.000Z');
    // Whatever the expression says, the next start is 15 minutes on.
    expect(nextRunAfter('* * * * *', 'UTC', slot, new Date('2026-10-06T12:00:05Z')).toISOString()).toBe('2026-10-06T12:15:00.000Z');
    // Started late (an outage): no catch-up burst right after.
    const late = new Date('2026-10-06T12:20:00Z');
    expect(nextRunAfter('*/15 * * * *', 'UTC', slot, late).getTime() - late.getTime()).toBeGreaterThanOrEqual(14 * 60_000);
  });
});
