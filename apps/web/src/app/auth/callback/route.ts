import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { supabaseServer } from '@/lib/auth';
import { safeNext, urlFor } from '@/lib/next-path';

// Finishes email confirmation, magic links and password resets (PKCE code or
// token hash), then sends the user on to the app.
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const next = safeNext(url.searchParams.get('next'));
  const sb = await supabaseServer();
  const code = url.searchParams.get('code');
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') as EmailOtpType | null;
  let error: string | null = url.searchParams.get('error_description');
  if (!error && code) error = (await sb.auth.exchangeCodeForSession(code)).error?.message ?? null;
  else if (!error && tokenHash && type) error = (await sb.auth.verifyOtp({ token_hash: tokenHash, type })).error?.message ?? null;
  if (!error) return NextResponse.redirect(urlFor(url.origin, next));
  const target = urlFor(url.origin, '/login');
  target.searchParams.set('error', /expired|invalid/i.test(error) ? 'That link has expired. Sign in, or request a new one.' : error);
  return NextResponse.redirect(target);
}
