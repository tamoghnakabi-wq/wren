import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}));
process.env.WREN_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'wren-upload-data-')));
const { saveDevice } = await import('../src/main/config');
const { INLINE_UPLOAD_BYTES, uploadArtifact } = await import('../src/main/upload');

// Up to 0.1.40 every shared file went to Wren's API in one request, and the hosting platform refuses a
// request over 4.5 MB before Wren sees it: sharing anything larger failed with "Upload failed (413)",
// though up to 50 MB was promised. A larger file now goes straight to the file store.

saveDevice({ deviceId: 'device-1', token: 'not-a-real-token', channel: 'c', supabase: { url: 'http://wren.test', key: 'k' }, appUrl: 'http://wren.test' });

interface Seen {
  url: string;
  method: string;
  lease: string | null;
  auth: string | null;
  body: unknown;
}
/** A stand-in for Wren's API: what it was asked, and what it answers. */
function server(answers: (s: Seen) => Response) {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    const s: Seen = { url, method: init.method ?? 'GET', lease: headers.get('x-wren-lease'), auth: headers.get('authorization'), body: init.body instanceof FormData ? init.body : JSON.parse(String(init.body)) };
    seen.push(s);
    return answers(s);
  });
  return seen;
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const run = { runId: '11111111-1111-4111-8111-111111111111', lease: '22222222-2222-4222-8222-222222222222' };

afterEach(() => vi.unstubAllGlobals());

describe('sending a file to Wren', () => {
  it('a small file (a screenshot) goes through the API in one request, as before', async () => {
    const seen = server(() => json({ id: 'a1', name: 'shot.jpg', size: 3 }, 201));
    const put = vi.fn();
    const a = await uploadArtifact({ ...run, data: Buffer.from('jpg'), name: 'shot.jpg', kind: 'screenshot' }, put);
    expect(a).toEqual({ id: 'a1', name: 'shot.jpg', size: 3 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: 'http://wren.test/api/device/artifacts', method: 'POST', lease: run.lease, auth: 'Device not-a-real-token' });
    const form = seen[0].body as FormData;
    expect([form.get('runId'), form.get('kind'), (form.get('file') as File).name]).toEqual([run.runId, 'screenshot', 'shot.jpg']);
    expect(put).not.toHaveBeenCalled();
  });

  it('a larger file goes to the file store with the token for its place, then is recorded under the run’s lease', async () => {
    const data = Buffer.alloc(INLINE_UPLOAD_BYTES + 1, 7);
    const seen = server((s) => (s.method === 'PUT' ? json({ id: 'big-1', name: 'export.zip', size: data.length }, 201) : json({ id: 'big-1', pathname: 'u/user/big-1/export.zip', token: 'one-place-token' }, 201)));
    const put = vi.fn(async () => ({}));
    const a = await uploadArtifact({ ...run, data, name: 'export.zip', kind: 'file' }, put);
    expect(a).toEqual({ id: 'big-1', name: 'export.zip', size: data.length });
    expect(seen.map((s) => [s.method, s.url, s.lease])).toEqual([
      ['POST', 'http://wren.test/api/device/artifacts/upload', run.lease],
      ['PUT', 'http://wren.test/api/device/artifacts/upload', run.lease],
    ]);
    expect(seen[0].body).toEqual({ runId: run.runId, name: 'export.zip', size: data.length });
    expect(seen[1].body).toEqual({ runId: run.runId, id: 'big-1', name: 'export.zip', kind: 'file' });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('u/user/big-1/export.zip', data, { access: 'private', token: 'one-place-token' });
  });

  it('nothing is sent to the store when Wren refuses the upload (a lost lease)', async () => {
    server(() => json({ error: 'This computer no longer holds this run.', code: 'lease_lost' }, 409));
    const put = vi.fn();
    await expect(uploadArtifact({ ...run, data: Buffer.alloc(INLINE_UPLOAD_BYTES + 1), name: 'export.zip', kind: 'file' }, put)).rejects.toMatchObject({ message: 'This computer no longer holds this run.', status: 409 });
    expect(put).not.toHaveBeenCalled();
  });

  it('a file the store didn’t take is never recorded', async () => {
    const seen = server(() => json({ id: 'big-1', pathname: 'u/user/big-1/export.zip', token: 't' }, 201));
    const put = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    await expect(uploadArtifact({ ...run, data: Buffer.alloc(INLINE_UPLOAD_BYTES + 1), name: 'export.zip', kind: 'file' }, put)).rejects.toThrow('Upload failed: the file store didn’t take the file (socket hang up)');
    expect(seen.map((s) => s.method)).toEqual(['POST']);
  });
});
