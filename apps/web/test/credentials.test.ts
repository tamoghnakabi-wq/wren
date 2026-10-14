import { describe, expect, it } from 'vitest';
import { hint } from '../src/lib/crypto';
import { probeMcp } from '../src/lib/mcp';

// Fabricated strings only: none of these is a credential.
describe('secret hints (W-171)', () => {
  it('never shows a short secret, or enough of any secret to rebuild it', () => {
    for (const s of ['abcd-1234', 'abcde-1234', 'abcdefgh', 'x'.repeat(20), 'tok-' + 'y'.repeat(18), '']) expect(hint(s), s).toBe('••••');
    for (let len = 1; len <= 80; len++) {
      for (const dash of [-1, 1, 2, 3, 4, 5, 6, 7]) {
        const s = Array.from({ length: len }, (_, i) => (i === dash ? '-' : String.fromCharCode(97 + (i % 26)))).join('');
        const h = hint(s);
        if (h === '••••') continue;
        const shown = h.replace('…', '').length;
        expect(len - shown, `${len}/${dash}`).toBeGreaterThanOrEqual(16);
        expect(len - shown, `${len}/${dash}`).toBeGreaterThanOrEqual(len / 2);
      }
    }
  });
  it('still tells long keys apart', () => {
    expect(hint('sk-proj-' + 'a'.repeat(40) + 'WXYZ')).toBe('sk-…WXYZ');
    expect(hint('ghp_' + 'b'.repeat(32) + '1234')).toBe('ghp…1234');
  });
});

describe('MCP transport (W-170)', () => {
  it('refuses to send a token over plain http, before connecting', async () => {
    // A public IP literal, so nothing is looked up; the refusal comes before any connection.
    await expect(probeMcp('http://93.184.215.14/mcp', 'not-a-real-token')).rejects.toThrow(/https:\/\//);
  });
});
