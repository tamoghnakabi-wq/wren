import { beforeEach, describe, expect, it, vi } from 'vitest';

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
let blobDelete: () => Promise<void> = async () => {};
let sandboxGet: () => Promise<{ delete: () => Promise<void> }> = async () => ({ delete: async () => {} });
vi.mock('@vercel/blob', async () => {
  class BlobNotFoundError extends Error {}
  return { BlobNotFoundError, del: () => blobDelete() };
});
vi.mock('@vercel/sandbox', () => ({ Sandbox: { get: () => sandboxGet() } }));
const { BlobNotFoundError } = (await import('@vercel/blob')) as unknown as { BlobNotFoundError: new (m?: string) => Error };
const { cleanUp, runCleanups } = await import('../src/lib/cleanup');

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
});
