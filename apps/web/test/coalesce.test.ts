import { describe, expect, it } from 'vitest';
import { coalesce } from '../src/lib/client/coalesce';

// W-84: history loads never overlap, so they can't finish out of order.
describe('coalesce', () => {
  it('runs one at a time and once more after calls that came in meanwhile', async () => {
    const log: string[] = [];
    let n = 0;
    let release: () => void = () => {};
    const run = coalesce(async () => {
      const id = ++n;
      log.push(`start ${id}`);
      if (id === 1) await new Promise<void>((r) => (release = r));
      log.push(`end ${id}`);
    });
    const a = run();
    const b = run();
    const c = run();
    expect(log).toEqual(['start 1']); // the later calls didn't start a second load
    release();
    await Promise.all([a, b, c]);
    expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2']); // two calls meanwhile: one more run, after the first
    await run();
    expect(log.slice(-2)).toEqual(['start 3', 'end 3']);
  });
  it('recovers after a failed run', async () => {
    let fail = true;
    const run = coalesce(async () => {
      if (fail) throw new Error('network');
    });
    await expect(run()).rejects.toThrow('network');
    fail = false;
    await expect(run()).resolves.toBeUndefined();
  });
});
