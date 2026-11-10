import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/lib/client/api';

// An error that didn't come from Wren's API (the hosting platform's 413, a gateway's 502 page) was shown
// to the user as it came: "Request Entity Too Large FUNCTION_PAYLOAD_TOO_LARGE syd1::f7vhm-…".

const answer = (status: number, body: string, type = 'text/plain') => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers: { 'content-type': type } })));
afterEach(() => vi.unstubAllGlobals());

describe('errors that aren’t Wren’s own', () => {
  it('the platform’s "too large" isn’t shown as it came', async () => {
    answer(413, 'Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE\n\nsyd1::f7vhm-1794298470132-66fe9bea67cd\n');
    const e = await api('/api/files', { form: new FormData() }).catch((x: ApiError) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).message).toBe('That’s too large to send.');
    expect((e as ApiError).status).toBe(413);
  });

  it('nor a gateway’s error page', async () => {
    answer(502, '<html><body><h1>502 Bad Gateway</h1></body></html>', 'text/html');
    await expect(api('/api/me')).rejects.toThrow('Wren isn’t answering right now (502). Try again in a moment.');
  });

  it('Wren’s own errors are shown as before', async () => {
    answer(400, JSON.stringify({ error: 'Files can be up to 25 MB.', code: 'too_large' }), 'application/json');
    await expect(api('/api/files/upload', { body: {} })).rejects.toMatchObject({ message: 'Files can be up to 25 MB.', code: 'too_large', status: 400 });
  });
});
