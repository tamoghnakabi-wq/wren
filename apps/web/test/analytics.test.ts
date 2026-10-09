import { describe, expect, it } from 'vitest';
import { analyticsEvent } from '../src/lib/analytics';

// W-141: only the public site's pages are recorded, and never what follows their address.
describe('analytics events', () => {
  const view = (url: string) => analyticsEvent({ type: 'pageview', url });

  it('keeps public pages without query string or hash', () => {
    expect(view('https://wren.example/')).toEqual({ type: 'pageview', url: 'https://wren.example/' });
    expect(view('https://wren.example/download?from=x#mac')).toEqual({ type: 'pageview', url: 'https://wren.example/download' });
    expect(view('https://wren.example/legal#privacy')?.url).toBe('https://wren.example/legal');
  });

  it('drops every other page', () => {
    for (const url of [
      'https://wren.example/app/s/0d4c7b0e-1111-4222-8333-944445555666',
      'https://wren.example/app/link?code=ABCD-EFGH',
      'https://wren.example/login?next=%2Fapp%2Flink%3Fcode%3DABCD',
      'https://wren.example/signup',
      'https://wren.example/auth/update-password',
      'https://wren.example/auth/mfa?next=/app',
      'https://wren.example/download/extra',
      'https://wren.example/legal/',
      'not a url',
    ])
      expect(view(url)).toBeNull();
  });
});
