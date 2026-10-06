import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { safeNext, urlFor } from './lib/next-path';

// Refreshes the Supabase session cookie and keeps signed-out visitors out of
// the app. Authorization itself happens in every API route.
export async function proxy(request: NextRequest) {
  // The app layout sends unfinished two-step sign-ins back here afterwards.
  request.headers.set('x-wren-path', request.nextUrl.pathname + request.nextUrl.search);
  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await supabase.auth.getClaims();
  const signedIn = !!data?.claims?.sub;
  const path = request.nextUrl.pathname;

  if (!signedIn && path.startsWith('/app')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  if (signedIn && (path === '/login' || path === '/signup')) {
    return NextResponse.redirect(urlFor(request.nextUrl.origin, safeNext(request.nextUrl.searchParams.get('next'))));
  }
  return response;
}

export const config = {
  matcher: ['/app/:path*', '/login', '/signup', '/auth/:path*'],
};
