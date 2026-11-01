import { describe, expect, it } from 'vitest';
import { commandOutput } from '../src/lib/runner/capped-read';

// What Wren reads back from a command in the agent's computer is capped (W-191): the agent can make any
// program there print without end, and stdout() would collect all of it into the function.
function command(pieces: number, size: number) {
  const seen = { yielded: 0, closed: false };
  return {
    seen,
    logs: (opts?: { signal?: AbortSignal }) =>
      (async function* () {
        try {
          for (let i = 0; i < pieces; i++) {
            if (opts?.signal?.aborted) return;
            seen.yielded++;
            yield { stream: i % 5 === 0 ? 'stderr' : 'stdout', data: 'x'.repeat(size) };
          }
        } finally {
          seen.closed = true;
        }
      })(),
  };
}

describe('reading a command’s output from the agent’s computer', () => {
  it('stops fetching once the output passes the limit', async () => {
    const cmd = command(10_000, 64 * 1024); // 625 MB if all of it came in
    const r = await commandOutput(cmd, 256 * 1024);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(256 * 1024);
    expect(cmd.seen.yielded).toBeLessThanOrEqual(5);
    expect(cmd.seen.closed).toBe(true);
  });

  it('returns all of a small output, stdout only', async () => {
    const cmd = command(3, 10);
    const r = await commandOutput(cmd, 4096);
    expect(r).toEqual({ stdout: 'x'.repeat(20), truncated: false });
  });

  it("fails at once when the caller's signal aborts while the stream is held, and ends the stream (W-191)", async () => {
    // A stream that sends one line and then nothing more: one that ignores its signal, and one that ends
    // quietly when its signal aborts (either way the output read so far is not all of it).
    for (const ends of ['never', 'quietly'] as const) {
      let given: AbortSignal | undefined;
      let sent = () => {};
      const first = new Promise<void>((r) => (sent = r));
      const cmd = {
        logs: (opts?: { signal?: AbortSignal }) =>
          (async function* () {
            given = opts?.signal;
            yield { stream: 'stdout', data: 'partial ' };
            sent();
            await new Promise<void>((r) => {
              if (ends === 'quietly') given?.addEventListener('abort', () => r(), { once: true });
            });
          })(),
      };
      const stop = new AbortController();
      const reading = commandOutput(cmd, 4096, stop.signal).then(
        (r) => ({ resolved: r }),
        (e: Error) => ({ rejected: e.name }),
      );
      await first;
      stop.abort();
      const r = await Promise.race([reading, new Promise((r) => setTimeout(() => r('still reading'), 1000))]);
      expect(r, ends).toEqual({ rejected: 'AbortError' });
      expect(given?.aborted, ends).toBe(true); // the SDK's request for the stream ends too
    }
    // Already stopped: the stream isn't asked for.
    let asked = false;
    const lazy = {
      logs: () => {
        asked = true;
        return command(1, 1).logs();
      },
    };
    await expect(commandOutput(lazy, 4096, AbortSignal.abort())).rejects.toThrow();
    expect(asked).toBe(false);
  });
});
