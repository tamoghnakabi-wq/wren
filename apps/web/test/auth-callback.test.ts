import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Email confirmation is on (2026-11-08). A confirmation link opened in another browser (a phone's
// mail app) has confirmed the address, but its code can't be finished there (the verifier is in the
// first browser's cookies): before, the sign-in page showed supabase-js's own message about PKCE.

let exchange: { error: { message: string; code?: string } | null };
const supabaseServer = vi.fn(async () => ({
  auth: {
    exchangeCodeForSession: vi.fn(async () => exchange),
    verifyOtp: vi.fn(async () => ({ error: null })),
  },
}));
vi.mock('@/lib/auth', () => ({ supabaseServer }));
vi.mock('@/lib/next-path', () => import('../src/lib/next-path'));

const { GET } = await import('../src/app/auth/callback/route');

const SITE = 'https://wren-agents.vercel.app';
const MISSING = { message: 'PKCE code verifier not found in storage. This can happen if …', code: 'pkce_code_verifier_not_found' };

async function open(query: string) {
  const res = await GET(new NextRequest(`${SITE}/auth/callback?${query}`));
  const to = new URL(res.headers.get('location')!);
  return { path: to.pathname, params: Object.fromEntries(to.searchParams) };
}

beforeEach(() => {
  exchange = { error: null };
});

describe('a link opened in another browser', () => {
  it('a sign-up link says the email is confirmed and asks to sign in, keeping where to go next', async () => {
    exchange = { error: MISSING };
    expect(await open('code=abc&signup=1&next=%2Fapp%2Flink%3Fcode%3DXY')).toEqual({ path: '/login', params: { notice: 'confirmed', next: '/app/link?code=XY' } });
  });

  it('any other link says to open it where it was asked for (not the PKCE message)', async () => {
    exchange = { error: MISSING };
    const r = await open('code=abc&next=%2Fauth%2Fupdate-password');
    expect(r.path).toBe('/login');
    expect(r.params.error).toMatch(/different browser/);
    expect(r.params.error).not.toMatch(/PKCE/);
    expect(r.params.notice).toBeUndefined();
  });
});

describe('everything else is as before', () => {
  it('a link finished in its own browser goes on to the app', async () => {
    expect(await open('code=abc&signup=1&next=%2Fapp%2Fagents')).toEqual({ path: '/app/agents', params: {} });
  });

  it('an expired or used link says so', async () => {
    exchange = { error: { message: 'invalid flow state, no valid flow state found', code: 'flow_state_not_found' } };
    expect((await open('code=abc&signup=1')).params).toEqual({ error: 'That link has expired. Sign in, or request a new one.' });
  });

  it('a link Supabase already refused keeps its reason, and the notice only comes from a missing verifier', async () => {
    exchange = { error: MISSING };
    expect((await open('error_description=Email+link+is+invalid+or+has+expired&signup=1')).params).toEqual({ error: 'That link has expired. Sign in, or request a new one.' });
  });
});
