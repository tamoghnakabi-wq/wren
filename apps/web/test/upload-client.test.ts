import { beforeEach, describe, expect, it, vi } from 'vitest';

// The composer's upload: a small file goes through the API as before, a larger one straight to the file
// store (the API can't take it: 4.5 MB a request on Vercel), and one over 25 MB is refused before
// anything is sent. Before, every file went to the API and anything over 4.5 MB failed with the
// platform's own error text shown as it came.

const h = vi.hoisted(() => ({ calls: [] as { path: string; opts: Record<string, unknown> }[], puts: [] as { pathname: string; size: number; options: Record<string, unknown> }[], putFails: false }));

vi.mock('../src/lib/client/api', () => ({
  api: async (path: string, opts: Record<string, unknown> = {}) => {
    h.calls.push({ path, opts });
    if (path === '/api/files') return { artifactId: 'small-1', name: 'note.txt', mime: 'text/plain', size: 3 };
    if (opts.method === 'PUT') return { artifactId: 'big-1', name: 'video.mp4', mime: 'video/mp4', size: 6 * 1024 * 1024 };
    return { id: 'big-1', pathname: 'u/user/big-1/video.mp4', token: 'one-place-token' };
  },
}));
vi.mock('@vercel/blob/client', () => ({
  put: async (pathname: string, body: File, options: Record<string, unknown>) => {
    if (h.putFails) throw new Error('network');
    h.puts.push({ pathname, size: body.size, options });
    return {};
  },
}));

const { uploadFile, INLINE_UPLOAD_BYTES, MAX_UPLOAD_BYTES } = await import('../src/lib/client/upload');
const file = (name: string, bytes: number, type = '') => new File([new Uint8Array(bytes)], name, { type });

beforeEach(() => {
  h.calls.length = h.puts.length = 0;
  h.putFails = false;
});

describe('attaching a file', () => {
  it('a small file goes through the API in one request', async () => {
    const a = await uploadFile(file('note.txt', 3, 'text/plain'));
    expect(a.artifactId).toBe('small-1');
    expect(h.calls.map((c) => c.path)).toEqual(['/api/files']);
    expect(h.calls[0].opts.form).toBeInstanceOf(FormData);
    expect(h.puts).toHaveLength(0);
  });

  it('a file right at the line still does', async () => {
    await uploadFile(file('edge.bin', INLINE_UPLOAD_BYTES));
    expect(h.calls.map((c) => c.path)).toEqual(['/api/files']);
  });

  it('a larger file goes to the file store with the token for its place, then is recorded', async () => {
    const a = await uploadFile(file('video.mp4', 6 * 1024 * 1024, 'video/mp4'));
    expect(a).toEqual({ artifactId: 'big-1', name: 'video.mp4', mime: 'video/mp4', size: 6 * 1024 * 1024 });
    expect(h.calls).toEqual([
      { path: '/api/files/upload', opts: { body: { name: 'video.mp4', size: 6 * 1024 * 1024 } } },
      { path: '/api/files/upload', opts: { method: 'PUT', body: { id: 'big-1', name: 'video.mp4' } } },
    ]);
    expect(h.puts).toEqual([{ pathname: 'u/user/big-1/video.mp4', size: 6 * 1024 * 1024, options: { access: 'private', token: 'one-place-token', contentType: 'video/mp4' } }]);
  });

  it('a file over 25 MB is refused before anything is sent', async () => {
    await expect(uploadFile(file('huge.iso', MAX_UPLOAD_BYTES + 1))).rejects.toThrow('huge.iso is larger than 25 MB, the most an attachment can be.');
    expect(h.calls).toHaveLength(0);
    expect(h.puts).toHaveLength(0);
  });

  it('a failed send to the store is said plainly and nothing is recorded', async () => {
    h.putFails = true;
    await expect(uploadFile(file('video.mp4', 6 * 1024 * 1024))).rejects.toThrow('video.mp4 couldn’t be uploaded. Check your connection and try again.');
    expect(h.calls.map((c) => c.opts.method)).toEqual([undefined]); // started, never finished
  });
});
