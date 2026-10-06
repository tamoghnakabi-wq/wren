import { NextResponse, type NextRequest } from 'next/server';
import { currentUser, supabaseServer } from '@/lib/auth';
import { mfaFacts } from '@/lib/mfa';

// Where the app sends a browser whose session Supabase Auth has ended (signed out elsewhere,
// revoked) while its token is still unexpired: drop the cookies and go to the sign-in page.
// Only ever signs out a session that has already ended, so a link here from elsewhere can't.
export async function GET(request: NextRequest) {
  const u = await currentUser();
  const target = request.nextUrl.clone();
  target.search = '';
  if (u && (await mfaFacts(u)).sessionAlive) {
    target.pathname = '/app';
    return NextResponse.redirect(target);
  }
  if (u) await (await supabaseServer()).auth.signOut({ scope: 'local' });
  target.pathname = '/login';
  return NextResponse.redirect(target);
}
