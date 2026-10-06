import { describe, expect, it } from 'vitest';
import { safeNext, urlFor } from '../src/lib/next-path';

describe('where sign-in sends you next', () => {
  it('keeps app paths with their query (pairing links)', () => {
    expect(safeNext('/app/link?code=ABCD-EFGH')).toBe('/app/link?code=ABCD-EFGH');
    expect(safeNext('/app')).toBe('/app');
    expect(safeNext('/app/sessions/1?tab=files')).toBe('/app/sessions/1?tab=files');
    expect(safeNext('/auth/update-password')).toBe('/auth/update-password');
    expect(urlFor('https://wren.example', safeNext('/app/link?code=X')).href).toBe('https://wren.example/app/link?code=X');
  });

  it('sends anything else to /app', () => {
    for (const n of [null, '', 'app', '//evil.example/app', '/\\evil.example/app', 'https://evil.example/app', '/app/../login', '/apple', '/login?next=/app', '/auth/mfa', 'javascript:alert(1)', '/%2e%2e/login']) {
      expect(safeNext(n), String(n)).toBe('/app');
    }
  });

  it('drops a fragment and normalizes the path', () => {
    expect(safeNext('/app/./settings#x')).toBe('/app/settings');
  });
});
