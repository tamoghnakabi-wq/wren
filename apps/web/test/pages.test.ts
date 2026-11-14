import { describe, expect, it } from 'vitest';
import config from '../next.config';
import { framedByWren, PAGE_CSP, pageDocument, pageHeaders } from '../src/lib/pages';

// Pages agents make (task.show_page) run sandboxed: an opaque origin, no network but pinned CDNs, no forms,
// and only as a frame of Wren's own pages.

describe('the page policy', () => {
  const rules = Object.fromEntries(PAGE_CSP.split('; ').map((r) => [r.split(' ')[0], r]));

  it('sandboxes the page and keeps it off the network', () => {
    expect(rules.sandbox).toBe('sandbox allow-scripts'); // no allow-same-origin, forms, popups or top navigation
    expect(rules['default-src']).toBe("default-src 'none'");
    expect(rules['connect-src']).toBe("connect-src 'none'");
    expect(rules['img-src']).toBe('img-src data: blob:');
    expect(rules['form-action']).toBe("form-action 'none'");
    expect(rules['frame-ancestors']).toBe("frame-ancestors 'self'");
    expect(rules['script-src']).not.toMatch(/\*|https:(\s|$)|http:/);
  });

  it('is served as HTML that is never kept or sniffed', () => {
    const h = pageHeaders();
    expect(h['content-type']).toBe('text/html; charset=utf-8');
    expect(h['content-security-policy']).toBe(PAGE_CSP);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['cache-control']).toBe('private, no-store');
    expect(h['referrer-policy']).toBe('no-referrer');
  });

  it('is served only as a frame of a Wren page', () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(framedByWren(h({ 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(framedByWren(h({ 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' }))).toBe(false); // opened as a tab
    expect(framedByWren(h({ 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' }))).toBe(false); // another site's frame
    expect(framedByWren(h({}))).toBe(false); // a browser that doesn't say
  });
});

describe('what goes around a page', () => {
  const ours = /<meta charset="utf-8"><meta name="color-scheme" content="dark">.*--wren-bg:#0c0c0c.*wrenPage/;

  it('goes first in the head, wherever the page starts one', () => {
    const withHead = pageDocument('<!doctype html><html lang="en"><head><title>T</title><style>body{color:red}</style></head><body>x</body></html>', 'dark');
    expect(withHead).toMatch(/^<!doctype html><html lang="en"><head><meta charset/);
    expect(withHead.indexOf('--wren-bg')).toBeLessThan(withHead.indexOf('body{color:red}')); // the page's own styles win
    expect(withHead).toMatch(ours);
    expect(pageDocument('<HTML><body>x</body></HTML>', 'dark')).toMatch(/^<HTML><head><meta charset.*<\/head><body>x/);
    expect(pageDocument('<!DOCTYPE html>\n<body>x</body>', 'dark')).toMatch(/^<!DOCTYPE html><head>.*<\/head>\n<body>x/);
    expect(pageDocument('<p>just a fragment</p>', 'light')).toMatch(/^<!doctype html><head>.*content="light".*--wren-bg:#ffffff.*<\/head><p>just a fragment<\/p>$/);
  });
});

describe('site headers for pages', () => {
  it('let Wren frame agents’ pages, and frame nothing but Wren', async () => {
    const all = await config.headers!();
    const pages = all.find((h) => h.source === '/api/pages/:id');
    expect(pages?.headers).toEqual([{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }]);
    // Later than the site-wide DENY, so it wins for that path.
    expect(all.indexOf(pages!)).toBeGreaterThan(all.findIndex((h) => h.source === '/(.*)'));
    const app = all.find((h) => h.headers.some((x) => x.key === 'Content-Security-Policy'));
    expect(app?.source).toBe('/((?!api/).*)');
    expect(app?.headers).toEqual([{ key: 'Content-Security-Policy', value: "frame-src 'self'" }]);
  });
});
