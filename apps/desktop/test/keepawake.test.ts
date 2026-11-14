import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeepAwake, type SleepBlocker } from '../src/main/keepawake';

// The computer stays awake while tasks run on it and for a minute after; the setting and quitting let it sleep at once.
function blocker() {
  let next = 1;
  const held = new Set<number>();
  const b: SleepBlocker & { held: Set<number>; starts: number } = {
    held,
    starts: 0,
    start: () => (b.starts++, held.add(next), next++),
    stop: (id) => void held.delete(id),
    isStarted: (id) => held.has(id),
  };
  return b;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('keeping the computer awake', () => {
  it('holds one blocker while tasks run, and lets go a minute after the last one ends', () => {
    const b = blocker();
    const k = new KeepAwake(b);
    k.update(true, true);
    k.update(true, true);
    expect(b.starts).toBe(1);
    expect(b.held.size).toBe(1);
    k.update(false, true);
    vi.advanceTimersByTime(59_000);
    expect(b.held.size).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(b.held.size).toBe(0);
    expect(k.holding).toBe(false);
  });

  it('keeps holding when a task starts within that minute', () => {
    const b = blocker();
    const k = new KeepAwake(b);
    k.update(true, true);
    k.update(false, true);
    vi.advanceTimersByTime(30_000);
    k.update(true, true);
    vi.advanceTimersByTime(120_000);
    expect(b.held.size).toBe(1);
    expect(b.starts).toBe(1);
  });

  it('lets go at once when the setting is off or Wren quits', () => {
    const b = blocker();
    const k = new KeepAwake(b);
    k.update(true, true);
    k.update(true, false);
    expect(b.held.size).toBe(0);
    k.update(true, false);
    expect(b.starts).toBe(1);
    k.update(true, true);
    k.stop();
    expect(b.held.size).toBe(0);
  });

  it('starts again if the system dropped the blocker', () => {
    const b = blocker();
    const k = new KeepAwake(b);
    k.update(true, true);
    b.held.clear();
    k.update(true, true);
    expect(b.held.size).toBe(1);
    expect(b.starts).toBe(2);
  });

  it('never holds anything when no task ran', () => {
    const b = blocker();
    const k = new KeepAwake(b);
    k.update(false, true);
    vi.advanceTimersByTime(120_000);
    expect(b.starts).toBe(0);
  });
});
