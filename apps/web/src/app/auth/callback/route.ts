import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { supabaseServer } from '@/lib/auth';
import { safeNext, urlFor } from '@/lib/next-path';

// Finishes email confirmation, magic links and password resets (PKCE code or
// token hash), then sends the user on to the app.
//
// A code link only finishes in the browser that asked for it: the code's verifier is in that
// browser's cookies. Opened anywhere else (a phone's mail app, another browser), the sign-up link has
// still confirmed the address (Supabase confirms before it hands out the code), so the user just signs
// in; any other link has to be opened where it was asked for, or asked for again.
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const next = safeNext(url.searchParams.get('next'));
  const sb = await supabaseServer();
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  let error: string | null = url.searchParams.get('error_description');
  if (!error && code) {
    const failed = (await sb.auth.exchangeCodeForSession(code)).error;
    if (failed?.code === 'pkce_code_verifier_not_found') {
      const target = urlFor(url.origin, '/login');
      if (url.searchParams.get('signup') === '1') target.searchParams.set('notice', 'confirmed');
      else target.searchParams.set('error', 'That link was opened in a different browser from the one you asked from. Open it there, or ask for a new one.');
      if (next !== '/app') target.searchParams.set('next', next);
      return NextResponse.redirect(target);
    }
    error = failed?.message ?? null;
  } else if (!error && tokenHash && type) error = (await sb.auth.verifyOtp({ token_hash: tokenHash, type })).error?.message ?? null;
  if (!error) return NextResponse.redirect(urlFor(url.origin, next));
  const target = urlFor(url.origin, '/login');
  target.searchParams.set('error', /expired|invalid/i.test(error) ? 'That link has expired. Sign in, or request a new one.' : error);
  return NextResponse.redirect(target);
}
