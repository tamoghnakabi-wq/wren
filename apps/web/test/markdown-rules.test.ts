import { describe, expect, it } from 'vitest';
import { isFileImage, safeHref } from '../src/lib/markdown-rules';

// An image in an agent's answer is requested as soon as the answer is drawn, with the user's sign-in.
// "Starts with /api/files/" let it be any address on the site (`/api/files/../…`).

const ID = '3f2b8c1e-9a4d-4e7f-8b1a-2c3d4e5f6a7b';

describe('images in agent output', () => {
  it('a stored file loads', () => {
    expect(isFileImage(`/api/files/${ID}`)).toBe(true);
    expect(isFileImage(`/api/files/${ID.toUpperCase()}`)).toBe(true);
  });

  it('nothing else on the site does', () => {
    for (const src of [
      '/api/files/../models?source=openai',
      '/api/files/../../auth/signout',
      `/api/files/${ID}/../../me`,
      `/api/files/${ID}?download`,
      `/api/files/${ID}#x`,
      '/api/files/',
      '/api/files/not-an-id',
      `/api/files/${ID}\n`,
      `//evil.example/api/files/${ID}`,
      `https://evil.example/api/files/${ID}`,
      `/API/files/${ID}/..%2f..%2fauth%2fsignout`,
    ])
      expect(isFileImage(src), src).toBe(false);
    for (const src of [undefined, null, 42, {}]) expect(isFileImage(src)).toBe(false);
  });
});

describe('links in agent output', () => {
  it('web, mail and in-app addresses are kept', () => {
    for (const href of ['https://example.com/a?b=1', 'http://example.com', 'mailto:someone@example.com', '/app/files']) expect(safeHref(href)).toBe(href);
  });

  it('anything that would run or open something else is dropped', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', 'file:///etc/passwd', 'wren://x', ' javascript:alert(1)', '', undefined, null]) expect(safeHref(href)).toBeUndefined();
  });
});
