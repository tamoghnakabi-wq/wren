import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake database that answers by query text and records what ran.
const queries: { text: string; values: unknown[] }[] = [];
let answers: (text: string) => unknown[] = () => [];
vi.mock('../src/lib/db', () => ({
  db: () => (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ');
    queries.push({ text, values });
    return Promise.resolve(answers(text));
  },
}));
let blobDelete: (signal?: AbortSignal) => Promise<void> = async () => {};
let sandboxGet: () => Promise<{ delete: () => Promise<void> }> = async () => ({ delete: async () => {} });
vi.mock('@vercel/blob', async () => {
  class BlobNotFoundError extends Error {}
  return { BlobNotFoundError, del: (_ref: string, o?: { abortSignal?: AbortSignal }) => blobDelete(o?.abortSignal) };
});
vi.mock('@vercel/sandbox', () => ({ Sandbox: { get: () => sandboxGet() } }));
const { BlobNotFoundError } = (await import('@vercel/blob')) as unknown as { BlobNotFoundError: new (m?: string) => Error };
const { cleanUp, runCleanups } = await import('../src/lib/cleanup');

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  queries.length = 0;
  answers = () => [];
  blobDelete = async () => {};
  sandboxGet = async () => ({ delete: async () => {} });
});

describe('deleting what lives outside the database (W-157)', () => {
  it("counts each provider's own \"not found\" as done (W-161)", async () => {
    blobDelete = async () => {
      throw new BlobNotFoundError('The requested blob does not exist');
    };
    await cleanUp('blob', 'u/1/2/a.txt');
    sandboxGet = async () => {
      throw Object.assign(new Error('Not Found'), { response: new Response(null, { status: 404 }) });
    };
    await cleanUp('sandbox', 'wren-agent-x');
    expect(queries).toHaveLength(0); // nothing kept for retrying
  });

  it('keeps any other failure for the cron', async () => {
    blobDelete = async () => {
      throw new Error('Service unavailable');
    };
    await cleanUp('blob', 'u/1/2/b.txt');
    expect(queries[0].text).toContain('insert into public.external_cleanups');
    expect(queries[0].values.slice(0, 2)).toEqual(['blob', 'u/1/2/b.txt']);
  });

  it("acknowledges a retried deletion only if nothing renewed it meanwhile (W-162)", async () => {
    answers = (text) => (text.startsWith('select id, kind, ref') ? [{ id: 7, kind: 'sandbox', ref: 'wren-agent-y', attempts: 0, version: '901' }] : []);
    expect(await runCleanups()).toBe(0); // deleted at the provider, but the row changed: left for the next round
    const ack = queries.find((q) => q.text.startsWith('delete from public.external_cleanups'))!;
    expect(ack.text).toContain('xmin::text = ?');
    expect(ack.values).toEqual([7, '901']);

    queries.length = 0;
    answers = (text) => (text.startsWith('select id, kind, ref') ? [{ id: 7, kind: 'sandbox', ref: 'wren-agent-y', attempts: 0, version: '901' }] : text.startsWith('delete') ? [{ id: 7 }] : []);
    expect(await runCleanups()).toBe(1);
  });

  it('gives up on a deletion that hangs, with an abort the Blob SDK treats as final, and starts no more after its budget (W-164)', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    blobDelete = (signal) => {
      seen = signal;
      return new Promise(() => {}); // never answers
    };
    answers = (text) =>
      text.startsWith('select id, kind, ref')
        ? [
            { id: 1, kind: 'blob', ref: 'u/1/a', attempts: 0, version: '10' },
            { id: 2, kind: 'blob', ref: 'u/1/b', attempts: 0, version: '11' },
          ]
        : [];
    const done = runCleanups(10, 10_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await done).toBe(0);
    expect(seen?.aborted).toBe(true);
    expect((seen?.reason as Error).name).toBe('AbortError'); // not TimeoutError, which the Blob SDK retries
    const backoffs = queries.filter((q) => q.text.startsWith('update public.external_cleanups'));
    expect(backoffs.map((q) => q.values.at(-2))).toEqual([1]); // only the first was tried: the budget was spent
  });
});
