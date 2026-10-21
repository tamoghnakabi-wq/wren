import { beforeEach, describe, expect, it, vi } from 'vitest';

// web.fetch's address check is a DNS lookup that takes no signal (W-196). A resolver that stalls must not
// hold the tool past its time limit or a Stop: every check, the first and the one after each redirect,
// gives way to both, and no request starts once either has ended it.

const dns = { answers: [] as ('public' | 'hang')[], asked: [] as string[] };
vi.mock('node:dns/promises', () => ({
  lookup: (host: string) => {
    dns.asked.push(host);
    return dns.answers.shift() === 'public' ? Promise.resolve([{ address: '93.184.216.34', family: 4 }]) : new Promise(() => {});
  },
}));
// The guarded fetch's own connection (with its connect-time address check) is undici's: record what starts.
const sent: string[] = [];
vi.mock('undici', () => ({
  Agent: class {},
  fetch: async (url: string) => {
    sent.push(url);
    return new Response(null, { status: 302, headers: { location: 'https://two.example.test/next' } });
  },
}));

const { fetchReadable } = await import('../src/net');

const settled = <T>(p: Promise<T>, ms = 1000) =>
  Promise.race([p.then(() => 'resolved', (e: Error) => e), new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), ms))]);

beforeEach(() => {
  dns.answers = [];
  dns.asked = [];
  sent.length = 0;
});
describe('a stalled address check (W-196)', () => {
  it('ends at the time limit without starting a fetch', async () => {
    dns.answers = ['hang'];
    const started = Date.now();
    const e = await settled(fetchReadable('https://slow.example.test/', { guard: true, timeoutMs: 50 }));
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe('The page took longer than 1 s to load, so the fetch was stopped.');
    expect(Date.now() - started).toBeLessThan(900);
    expect(dns.asked).toEqual(['slow.example.test']);
    expect(sent).toHaveLength(0);
  });

  it("ends on the caller's Stop without starting a fetch", async () => {
    dns.answers = ['hang'];
    const stop = new AbortController();
    const p = settled(fetchReadable('https://slow.example.test/', { guard: true, signal: stop.signal }));
    await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    const e = await p;
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).name).toBe('AbortError');
    expect(sent).toHaveLength(0);

    // Already stopped: nothing is looked up or sent.
    const done = new AbortController();
    done.abort();
    expect(await settled(fetchReadable('https://slow.example.test/', { guard: true, signal: done.signal }))).toBeInstanceOf(Error);
    expect(dns.asked).toHaveLength(1);
    expect(sent).toHaveLength(0);
  });

  it("the check after a redirect gives way too, and the redirect's target isn't fetched", async () => {
    dns.answers = ['public', 'hang'];
    const e = await settled(fetchReadable('https://one.example.test/', { guard: true, timeoutMs: 100 }));
    expect((e as Error).message).toBe('The page took longer than 1 s to load, so the fetch was stopped.');
    expect(dns.asked).toEqual(['one.example.test', 'two.example.test']);
    expect(sent).toEqual(['https://one.example.test/']);
  });
});
