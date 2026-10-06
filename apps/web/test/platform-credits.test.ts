import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/auth', () => ({
  HttpError: class HttpError extends Error {
    constructor(
      public status: number,
      message: string,
      public code?: string,
    ) {
      super(message);
    }
  },
}));
const oidc = vi.fn(async () => 'operator-oidc-token');
vi.mock('@vercel/oidc', () => ({ getVercelOidcToken: oidc }));
process.env.PLATFORM_MODEL_USERS = 'owner@wren.test';

const credits = await import('../src/lib/platform-credits');
const { resolveCloudModel } = await import('../src/lib/models');

const owner = { id: '00000000-0000-0000-0000-000000000001', email: 'owner@wren.test' };

// Wren credits (the operator's Vercel AI Gateway account) are switched off for every account.
describe('Wren credits while switched off', () => {
  it('are off', () => {
    expect(credits.PLATFORM_CREDITS_ENABLED).toBe(false);
  });

  it('are off even for an account on the allowlist', () => {
    expect(credits.canUsePlatform(owner)).toBe(false);
    expect(() => credits.assertPlatformAllowed(owner)).toThrow(/turned off/);
    try {
      credits.assertPlatformAllowed(owner);
    } catch (e) {
      expect(e).toMatchObject({ status: 403, code: 'platform_disabled' });
    }
  });

  it('never hand out the operator token', async () => {
    await expect(credits.operatorGatewayToken()).rejects.toMatchObject({ status: 403, code: 'platform_disabled' });
    expect(oidc).not.toHaveBeenCalled();
  });

  it('refuse a cloud run before any model client exists', async () => {
    await expect(resolveCloudModel(owner, { source: 'platform', model: 'anthropic/claude-fable-5.1' }, async () => null)).rejects.toMatchObject({
      status: 403,
      code: 'platform_disabled',
    });
    expect(oidc).not.toHaveBeenCalled();
  });

  it('are reachable only through platform-credits.ts', () => {
    // Every model call billed to the operator must take the token from operatorGatewayToken(), which checks the switch.
    const src = join(__dirname, '../src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f)) files.push(p);
      }
    };
    walk(src);
    const users = files.filter((f) => /@vercel\/oidc|getVercelOidcToken/.test(readFileSync(f, 'utf8'))).map((f) => relative(src, f));
    expect(users).toEqual(['lib/platform-credits.ts']);
  });
});
