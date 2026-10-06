// Where to send someone after signing in, from a `next` parameter. Shared by the proxy, the auth
// callback, the sign-in form and the two-step sign-in page: only paths inside the app (or back to
// choosing a new password), always on this site, and with their query kept (a pairing link is
// /app/link?code=…).

const BASE = 'http://wren.invalid';

export function safeNext(next: string | null | undefined, fallback = '/app'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return fallback;
  let u: URL;
  try {
    u = new URL(next, BASE);
  } catch {
    return fallback;
  }
  if (u.origin !== BASE) return fallback;
  const ok = u.pathname === '/app' || u.pathname.startsWith('/app/') || u.pathname === '/auth/update-password';
  return ok ? u.pathname + u.search : fallback;
}

/** An absolute URL on `origin` for a path from safeNext() (pathname and query kept apart). */
export function urlFor(origin: string, path: string): URL {
  return new URL(path, origin);
}
