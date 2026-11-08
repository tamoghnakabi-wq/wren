import { describe, expect, it } from 'vitest';
import config from '../next.config';

// Every page and API answer carries the site-wide headers, including one that stops other sites from
// showing Wren in a frame (clickjacking an Approve or Link button).

describe('site-wide response headers', () => {
  it('forbid framing, sniffing and referrer paths', async () => {
    const all = (await config.headers!()).find((h) => h.source === '/(.*)');
    const h = Object.fromEntries((all?.headers ?? []).map((x) => [x.key.toLowerCase(), x.value]));
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('strict-origin');
  });
});
