import { beforeEach, describe, expect, it, vi } from 'vitest';

// A request to Wren's API carries at most 4.5 MB on Vercel (the platform answers 413 itself), so an
// attachment over that never arrived, though up to 25 MB was promised (50 MB for a file a computer
// shares). Larger files now go straight to the file store: Wren hands out a token for one place
// (startUpload) and records what arrived there (finishUpload). These run both over stand-ins for the
// store and the database (external_cleanups keeps the places that wait for their upload).

const h = vi.hoisted(() => ({
  store: new Map<string, { size: number; contentType: string }>(),
  tokens: [] as Record<string, unknown>[],
  deleted: [] as string[],
  pending: new Map<string, { minutes: number }>(),
  artifacts: [] as Record<string, unknown>[],
  leaseHeld: true,
}));

vi.mock('@vercel/blob', () => {
  class BlobNotFoundError extends Error {}
  return {
    BlobNotFoundError,
    head: async (p: string) => {
      const b = h.store.get(p);
      if (!b) throw new BlobNotFoundError('not found');
      return b;
    },
    get: async () => null,
    put: async () => ({}),
  };
});
vi.mock('@vercel/blob/client', () => ({
  generateClientTokenFromReadWriteToken: async (o: Record<string, unknown>) => {
    h.tokens.push(o);
    return `token-for:${String(o.pathname)}`;
  },
}));
vi.mock('../src/lib/cleanup', () => ({
  cleanUp: async (_kind: string, ref: string) => {
    h.deleted.push(ref);
    h.store.delete(ref);
  },
}));
vi.mock('../src/lib/auth', () => ({
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  },
}));
vi.mock('../src/lib/db', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('insert into public.external_cleanups')) {
      const [ref, , minutes, , prefix, cap] = values as [string, string, number, string, string, number];
      const underWay = [...h.pending.keys()].filter((k) => k.startsWith(prefix)).length;
      if (underWay >= cap) return Promise.resolve([]);
      h.pending.set(ref, { minutes });
      return Promise.resolve([{ id: 1 }]);
    }
    if (text.includes('delete from public.external_cleanups')) {
      const ref = values[0] as string;
      const p = h.pending.get(ref);
      if (!p || p.minutes <= 1) return Promise.resolve([]); // not handed out, or about to be cleared
      h.pending.delete(ref);
      return Promise.resolve([{ id: 1 }]);
    }
    if (text.includes('insert into public.artifacts')) {
      const leased = values.some((v) => v === 'LEASE-CHECK');
      if (leased && !h.leaseHeld) return Promise.resolve([]);
      const [id, userId, , , runId, name, mime, size, kind, path] = values as string[];
      h.artifacts.push({ id, userId, runId, name, mime, size, kind, path });
      return Promise.resolve([{ id }]);
    }
    if (text.includes('from public.runs where id =')) return 'LEASE-CHECK';
    return text.trim() === 'true' ? 'NO-LEASE' : Promise.resolve([]);
  };
  const withBegin = Object.assign(sql, {
    begin: async <T>(fn: (tx: typeof sql) => Promise<T>) => {
      const before = { pending: new Map(h.pending), artifacts: [...h.artifacts] };
      try {
        return await fn(sql);
      } catch (e) {
        h.pending = before.pending; // rolled back
        h.artifacts = before.artifacts;
        throw e;
      }
    },
  });
  return { db: () => withBegin };
});

const { finishUpload, startUpload, USER_UPLOAD_BYTES, DEVICE_UPLOAD_BYTES, INLINE_UPLOAD_BYTES } = await import('../src/lib/blob');

const USER = '11111111-1111-4111-8111-111111111111';
const MB = 1024 * 1024;

beforeEach(() => {
  h.store.clear();
  h.pending.clear();
  h.tokens.length = h.deleted.length = h.artifacts.length = 0;
  h.leaseHeld = true;
});

const arrive = (pathname: string, size: number, contentType = 'application/pdf') => h.store.set(pathname, { size, contentType });

describe('starting an upload', () => {
  it('small files still fit one request to the API, with room under the platform’s 4.5 MB', () => {
    expect(INLINE_UPLOAD_BYTES).toBeLessThan(4.5 * MB - 256 * 1024);
  });

  it('hands out a token for one place in the account’s folder, once, up to the limit', async () => {
    const u = await startUpload({ userId: USER, name: 'Quarterly report.pdf', size: 20 * MB, maxBytes: USER_UPLOAD_BYTES });
    expect(u.pathname).toBe(`u/${USER}/${u.id}/Quarterly report.pdf`);
    expect(h.tokens).toHaveLength(1);
    expect(h.tokens[0]).toMatchObject({ pathname: u.pathname, maximumSizeInBytes: 25 * MB, addRandomSuffix: false, allowOverwrite: false });
    expect(Number(h.tokens[0].validUntil)).toBeLessThanOrEqual(Date.now() + 31 * 60_000);
    // Written down before the token goes out, so an upload nobody finishes is cleared later.
    expect([...h.pending.keys()]).toEqual([u.pathname]);
  });

  it('a name can’t leave the account’s folder', async () => {
    const u = await startUpload({ userId: USER, name: '../../other/secret.txt', size: 5 * MB, maxBytes: USER_UPLOAD_BYTES });
    expect(u.pathname.startsWith(`u/${USER}/${u.id}/`)).toBe(true);
    expect(u.pathname.slice(`u/${USER}/${u.id}/`.length)).not.toContain('/');
  });

  it('refuses a file over the limit, or with no size, without a token', async () => {
    await expect(startUpload({ userId: USER, name: 'a.zip', size: 25 * MB + 1, maxBytes: USER_UPLOAD_BYTES })).rejects.toMatchObject({ status: 413, message: 'Files can be up to 25 MB.' });
    await expect(startUpload({ userId: USER, name: 'a.zip', size: 50 * MB + 1, maxBytes: DEVICE_UPLOAD_BYTES })).rejects.toMatchObject({ status: 413, message: 'Files can be up to 50 MB.' });
    for (const size of [0, -1, 1.5, Number.NaN]) await expect(startUpload({ userId: USER, name: 'a.zip', size, maxBytes: USER_UPLOAD_BYTES })).rejects.toMatchObject({ status: 400 });
    expect(h.tokens).toHaveLength(0);
    expect(h.pending.size).toBe(0);
  });

  it('an account can have only so many under way', async () => {
    for (let i = 0; i < 20; i++) await startUpload({ userId: USER, name: `f${i}.bin`, size: 5 * MB, maxBytes: USER_UPLOAD_BYTES });
    await expect(startUpload({ userId: USER, name: 'one-more.bin', size: 5 * MB, maxBytes: USER_UPLOAD_BYTES })).rejects.toMatchObject({ status: 429 });
    expect(h.tokens).toHaveLength(20);
    // Another account isn't held up by it.
    await expect(startUpload({ userId: '22222222-2222-4222-8222-222222222222', name: 'x.bin', size: 5 * MB, maxBytes: USER_UPLOAD_BYTES })).resolves.toBeTruthy();
  });
});

describe('finishing an upload', () => {
  it('records what arrived: the stored size and type, not what the client said', async () => {
    const u = await startUpload({ userId: USER, name: 'report.pdf', size: 5 * MB, maxBytes: USER_UPLOAD_BYTES });
    arrive(u.pathname, 12 * MB);
    const a = await finishUpload({ userId: USER, id: u.id, name: 'report.pdf', maxBytes: USER_UPLOAD_BYTES, kind: 'upload', source: 'user' });
    expect(a).toEqual({ id: u.id, name: 'report.pdf', size: 12 * MB, mime: 'application/pdf' });
    expect(h.artifacts).toEqual([expect.objectContaining({ id: u.id, userId: USER, size: 12 * MB, kind: 'upload', path: u.pathname })]);
    expect(h.pending.size).toBe(0); // no longer waiting, so the cron won't clear it
  });

  it('a file that never arrived isn’t recorded', async () => {
    const u = await startUpload({ userId: USER, name: 'report.pdf', size: 5 * MB, maxBytes: USER_UPLOAD_BYTES });
    await expect(finishUpload({ userId: USER, id: u.id, name: 'report.pdf', maxBytes: USER_UPLOAD_BYTES })).rejects.toMatchObject({ status: 400, code: 'upload_missing' });
    expect(h.artifacts).toHaveLength(0);
  });

  it('only a place Wren handed out can be recorded (not some other stored file)', async () => {
    const stray = `u/${USER}/33333333-3333-4333-8333-333333333333/old.pdf`;
    arrive(stray, 6 * MB);
    await expect(finishUpload({ userId: USER, id: '33333333-3333-4333-8333-333333333333', name: 'old.pdf', maxBytes: USER_UPLOAD_BYTES })).rejects.toMatchObject({ status: 410, code: 'upload_expired' });
    expect(h.artifacts).toHaveLength(0);
    expect(h.store.has(stray)).toBe(true); // and nothing is deleted on a guess
  });

  it('another account can’t finish it', async () => {
    const u = await startUpload({ userId: USER, name: 'report.pdf', size: 5 * MB, maxBytes: USER_UPLOAD_BYTES });
    arrive(u.pathname, 5 * MB);
    await expect(finishUpload({ userId: '22222222-2222-4222-8222-222222222222', id: u.id, name: 'report.pdf', maxBytes: USER_UPLOAD_BYTES })).rejects.toMatchObject({ code: 'upload_missing' });
    expect(h.artifacts).toHaveLength(0);
  });

  it('one the cron is about to clear is refused', async () => {
    const u = await startUpload({ userId: USER, name: 'report.pdf', size: 5 * MB, maxBytes: USER_UPLOAD_BYTES });
    arrive(u.pathname, 5 * MB);
    h.pending.get(u.pathname)!.minutes = 0.5;
    await expect(finishUpload({ userId: USER, id: u.id, name: 'report.pdf', maxBytes: USER_UPLOAD_BYTES })).rejects.toMatchObject({ status: 410 });
    expect(h.artifacts).toHaveLength(0);
  });

  it('a stored file over the limit is deleted, not recorded', async () => {
    const u = await startUpload({ userId: USER, name: 'big.zip', size: 5 * MB, maxBytes: USER_UPLOAD_BYTES });
    arrive(u.pathname, 26 * MB);
    await expect(finishUpload({ userId: USER, id: u.id, name: 'big.zip', maxBytes: USER_UPLOAD_BYTES })).rejects.toMatchObject({ status: 413 });
    expect(h.deleted).toEqual([u.pathname]);
    expect(h.artifacts).toHaveLength(0);
  });

  it('a run’s file is recorded only while the worker holds the run; otherwise its place stays due for clearing', async () => {
    const u = await startUpload({ userId: USER, name: 'out.zip', size: 30 * MB, maxBytes: DEVICE_UPLOAD_BYTES });
    arrive(u.pathname, 30 * MB, 'application/octet-stream');
    h.leaseHeld = false;
    const run = { runId: '44444444-4444-4444-8444-444444444444', leaseId: '55555555-5555-4555-8555-555555555555' };
    await expect(finishUpload({ userId: USER, id: u.id, name: 'out.zip', maxBytes: DEVICE_UPLOAD_BYTES, ...run, source: 'desktop' })).rejects.toMatchObject({ status: 409, code: 'lease_lost' });
    expect(h.artifacts).toHaveLength(0);
    expect(h.pending.has(u.pathname)).toBe(true);
    h.leaseHeld = true;
    const a = await finishUpload({ userId: USER, id: u.id, name: 'out.zip', maxBytes: DEVICE_UPLOAD_BYTES, ...run, source: 'desktop' });
    expect(a).toMatchObject({ size: 30 * MB, mime: 'application/zip' }); // an unnamed type is read from the name
  });
});
