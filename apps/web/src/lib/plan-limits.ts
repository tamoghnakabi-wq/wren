// Usage → This Mac → Plan limits: how fast a limit is being used up. An even pace uses a window's limit at
// the rate its time passes; more than 5 points ahead of that runs out before the reset. Pure, so it is
// tested on its own (test/plan-limits.test.ts).

import type { LimitWindow } from './client/desktop';

export type Pace = 'ahead' | 'on' | 'under';

export interface LimitPace {
  /** Share of the window's time gone, 0–1; null without a reset time or length. */
  elapsed: number | null;
  pace: Pace | null;
  /** When the limit runs out if use carries on at this rate, when that is before the reset. */
  runsOutAt: number | null;
}

/** Points either side of an even pace that still count as on pace. */
const SLACK = 5;

export function limitPace(w: LimitWindow, now: number): LimitPace {
  const none = { elapsed: null, pace: null, runsOutAt: null };
  if (w.resetsAt === null || !w.minutes || w.resetsAt <= now) return none;
  const length = w.minutes * 60_000;
  const start = w.resetsAt - length;
  const elapsed = Math.max(0, Math.min(1, (now - start) / length));
  const gap = w.used - elapsed * 100;
  const pace: Pace = gap > SLACK ? 'ahead' : gap < -SLACK ? 'under' : 'on';
  let runsOutAt: number | null = null;
  if (pace === 'ahead' && w.used > 0 && w.used < 100 && now > start) {
    const at = start + ((now - start) * 100) / w.used;
    if (at < w.resetsAt) runsOutAt = Math.max(now, at);
  }
  return { elapsed, pace, runsOutAt };
}

/** A time as "7:40 pm" today, "Sat 6:00 am" within the week, else "Dec 3, 6:00 am". */
export function whenText(at: number, now: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (new Date(now).toDateString() === d.toDateString()) return time;
  if (at - now < 6 * 24 * 3_600_000) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** What the pace means, in a few words (empty when it can't be judged). */
export function paceText(w: LimitWindow, now: number, when: (at: number) => string = (at) => whenText(at, now)): string {
  if (w.used >= 100) return w.resetsAt !== null && w.resetsAt > now ? `Used up until ${when(w.resetsAt)}` : 'Used up';
  const p = limitPace(w, now);
  if (p.runsOutAt !== null) return `At this pace it runs out around ${when(p.runsOutAt)}`;
  if (p.pace === 'on') return 'On pace to last until it resets';
  if (p.pace === 'under') return 'Plenty left at this pace';
  return '';
}
