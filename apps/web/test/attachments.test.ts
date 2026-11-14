import { beforeEach, describe, expect, it, vi } from 'vitest';

// Attached text files are read for the model only from the run's own account, only text, at most 1 MB.
const h = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], queries: [] as unknown[][], reads: [] as string[] }));
const db = () => (strings: TemplateStringsArray, ...values: unknown[]) => (h.queries.push([strings.join('?'), ...values]), Promise.resolve(h.rows));
vi.mock('../src/lib/db', () => ({ db }));
vi.mock('../src/lib/blob', () => ({ readArtifactBytes: async (p: string) => (h.reads.push(p), Buffer.from('file text')) }));
const { attachmentLoader } = await import('../src/lib/attachments');
const { pastedFileName } = await import('../src/lib/client/paste');

beforeEach(() => {
  h.rows = [];
  h.queries = [];
  h.reads = [];
});

describe('reading attached text for the model', () => {
  it('asks for the file by id within the account, and reads it once', async () => {
    h.rows = [{ blob_path: 'u/1/a/notes.txt', name: 'notes.txt', mime: 'text/plain', size: 9 }];
    const load = attachmentLoader('user-1');
    expect(new TextDecoder().decode((await load('file-1'))!)).toBe('file text');
    await load('file-1');
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]).toEqual([expect.stringMatching(/where id = \? and user_id = \?/), 'file-1', 'user-1']);
    expect(h.reads).toEqual(['u/1/a/notes.txt']);
  });

  it.each([
    ['another account’s file (no row)', []],
    ['a PDF', [{ blob_path: 'p', name: 'r.pdf', mime: 'application/pdf', size: 9 }]],
    ['an image', [{ blob_path: 'p', name: 'a.png', mime: 'image/png', size: 9 }]],
    ['a text file over 1 MB', [{ blob_path: 'p', name: 'big.csv', mime: 'text/csv', size: 2 * 1024 * 1024 }]],
  ])('reads nothing for %s', async (_what, rows) => {
    h.rows = rows;
    expect(await attachmentLoader('user-1')('file-1')).toBeNull();
    expect(h.reads).toEqual([]);
  });
});

describe('long pastes become files', () => {
  it('names each one after the ones already attached', () => {
    expect(pastedFileName([])).toBe('Pasted text 1.txt');
    expect(pastedFileName(['Pasted text 1.txt', 'notes.md'])).toBe('Pasted text 2.txt');
    expect(pastedFileName(['Pasted text 2.txt'])).toBe('Pasted text 1.txt');
  });
});
