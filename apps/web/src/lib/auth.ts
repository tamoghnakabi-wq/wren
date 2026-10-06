import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import { db } from './db';
import { sha256 } from './crypto';
import { env } from './env';
import { mfaStatusFor } from './mfa';

// Request authentication for API routes.
//  - Browser sessions: Supabase Auth cookies (verified locally against the
//    project's JWKS via getClaims()).
//  - Bearer access tokens (same JWT) for non-cookie clients.
//  - Desktop devices: "Authorization: Device <token>" (hashed in device_secrets).

export interface AuthUser {
  id: string;
  email: string;
  /** From the verified JWT: the Supabase Auth session, its assurance level and sign-in methods. */
  sessionId?: string;
  aal?: string;
  amr?: { method: string; timestamp: number }[];
}

type Claims = Record<string, unknown>;

export function userFromClaims(c: Claims | undefined): AuthUser | null {
  if (!c?.sub || (c.role !== undefined && c.role !== 'authenticated')) return null;
  return {
    id: String(c.sub),
    email: String(c.email ?? ''),
    sessionId: typeof c.session_id === 'string' ? c.session_id : undefined,
    aal: typeof c.aal === 'string' ? c.aal : undefined,
    amr: Array.isArray(c.amr) ? (c.amr as { method: string; timestamp: number }[]) : undefined,
  };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

let anon: ReturnType<typeof createClient> | undefined;

// getClaims() verifies asymmetric (ES256) tokens locally against the cached
// JWKS and falls back to the Auth server for symmetric keys (local stack).
async function verifyBearer(token: string): Promise<AuthUser | null> {
  anon ??= createClient(env.supabaseUrl, env.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.getClaims(token);
  if (error || data?.claims?.role !== 'authenticated') return null;
  return userFromClaims(data.claims as Claims);
}

export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(env.supabaseUrl, env.supabaseKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const c of list) store.set(c.name, c.value, c.options);
        } catch {
          // called from a context that can't set cookies; the proxy refreshes them
        }
      },
    },
  });
}

export async function currentUser(request?: Request): Promise<AuthUser | null> {
  const authz = request?.headers.get('authorization');
  if (authz?.startsWith('Bearer ')) return verifyBearer(authz.slice(7));
  const sb = await supabaseServer();
  const { data } = await sb.auth.getClaims();
  return userFromClaims(data?.claims as Claims | undefined);
}

/**
 * The signed-in user, who must also have finished two-step sign-in (MFA) in this session.
 *  - `mfa: 'skip'`: for the few routes that help finish it (status, email codes).
 *  - `stepUp: true`: sensitive actions, which also need a second step verified in the last few
 *    minutes (an authenticator code, a recovery code or an email code; see mfa-rules.ts).
 */
export async function requireUser(request?: Request, opts: { mfa?: 'skip'; stepUp?: boolean } = {}): Promise<AuthUser> {
  const u = await currentUser(request);
  if (!u) throw new HttpError(401, 'Sign in required.', 'unauthenticated');
  if (opts.mfa === 'skip' && !opts.stepUp) return u;
  const s = await mfaStatusFor(u);
  if (!s.satisfied) throw new HttpError(403, 'Finish signing in first: enter your verification code.', 'mfa_required');
  if (opts.stepUp && !s.stepUpUntil) throw new HttpError(403, 'Confirm it’s you to continue.', 'step_up_required');
  return u;
}

export interface AuthDevice {
  id: string;
  userId: string;
  name: string;
  platform: string;
}

export async function requireDevice(request: Request): Promise<AuthDevice> {
  const authz = request.headers.get('authorization') ?? '';
  if (!authz.startsWith('Device ')) throw new HttpError(401, 'Device token required.', 'unauthenticated');
  const hash = sha256(authz.slice(7).trim());
  const rows = await db()`
    select d.id, d.user_id, d.name, d.platform from public.device_secrets s
    join public.devices d on d.id = s.device_id
    where s.token_hash = ${hash} and d.revoked_at is null`;
  if (!rows.length) throw new HttpError(401, 'This device is not linked or was removed.', 'device_revoked');
  const d = rows[0];
  return { id: d.id, userId: d.user_id, name: d.name, platform: d.platform };
}

export function canUsePlatformModels(user: AuthUser): boolean {
  return env.platformModelUsers.includes(user.email.toLowerCase());
}
