import { describe, expect, it } from 'vitest';
import type { LimitWindow } from '../src/lib/client/desktop';
import { limitPace, paceText } from '../src/lib/plan-limits';

// Usage → This Mac → Plan limits (desktop 0.1.54): the pace of a limit, judged from its share used and the
// share of its window gone.

const HOUR = 3_600_000;
const now = Date.UTC(2026, 10, 26, 12, 0);
/** A 5-hour window with `left` hours to go. */
const session = (used: number, left: number): LimitWindow => ({ id: 'session', label: '5-hour limit', minutes: 300, used, resetsAt: now + left * HOUR });
const at = (t: number) => `T+${Math.round((t - now) / 60_000)}m`;

describe('plan limit pace', () => {
  it('is on pace within 5 points of the time gone', () => {
    // 2.5 of 5 hours gone: 50% is even.
    expect(limitPace(session(52, 2.5), now)).toEqual({ elapsed: 0.5, pace: 'on', runsOutAt: null });
    expect(paceText(session(52, 2.5), now, at)).toBe('On pace to last until it resets');
    expect(limitPace(session(20, 2.5), now).pace).toBe('under');
    expect(paceText(session(20, 2.5), now, at)).toBe('Plenty left at this pace');
  });

  it('says when an ahead limit runs out at this rate', () => {
    // 1 of 5 hours gone with 40% used: 100% after 2.5 hours, 90 minutes from now.
    const w = session(40, 4);
    expect(limitPace(w, now)).toMatchObject({ pace: 'ahead', runsOutAt: now + 1.5 * HOUR });
    expect(paceText(w, now, at)).toBe('At this pace it runs out around T+90m');
  });

  it('handles a used-up limit, a passed reset and a window without times', () => {
    expect(paceText(session(100, 2), now, at)).toBe('Used up until T+120m');
    expect(paceText({ ...session(100, 0), resetsAt: now - 1 }, now, at)).toBe('Used up');
    expect(limitPace({ ...session(30, 1), resetsAt: null }, now)).toEqual({ elapsed: null, pace: null, runsOutAt: null });
    expect(limitPace({ ...session(30, 1), minutes: null }, now).pace).toBeNull();
    expect(paceText({ ...session(30, 1), resetsAt: now - HOUR }, now, at)).toBe('');
  });

  it('judges a weekly window by its own length', () => {
    // 66% used with 2 days 15 hours to go: 4.375 of 7 days gone (62.5%), so on pace.
    const weekly: LimitWindow = { id: 'weekly', label: 'Weekly limit', minutes: 7 * 24 * 60, used: 66, resetsAt: now + 63 * HOUR };
    expect(limitPace(weekly, now)).toMatchObject({ pace: 'on', runsOutAt: null });
    expect(limitPace({ ...weekly, used: 80 }, now)).toMatchObject({ pace: 'ahead', runsOutAt: expect.any(Number) });
  });
});
