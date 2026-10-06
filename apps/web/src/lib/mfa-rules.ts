// What two-step sign-in a session still owes, as a pure function of the account's MFA facts and the
// session's JWT claims (shared by the API and tests; the database applies the same rule to reads
// through `wren_session_ok()`, migration 0009).

/** How long after verifying a second step sensitive actions go through without asking again. */
export const STEP_UP_SECONDS = 10 * 60;

/** `amr` methods that are a second factor (Supabase Auth names them like this in the JWT). */
const SECOND_FACTOR = new Set(['totp', 'mfa/totp', 'mfa/recovery_code', 'phone', 'mfa/phone', 'webauthn', 'mfa/webauthn']);

export interface MfaFacts {
  /** Verified Supabase Auth factors of any kind (authenticator apps, recovery codes, …). */
  factors: number;
  /** Verified authenticator apps. */
  totp: number;
  recoveryCodes: boolean;
  /** The user turned on email codes. */
  email: boolean;
  /** When this session last passed an email code (null if never, or if the session is gone). */
  emailVerifiedAt: Date | null;
}

export interface SessionClaims {
  aal?: string;
  amr?: { method: string; timestamp: number }[];
}

/** What signing in needs after the password: nothing, an authenticator app (or recovery code), or an email code. */
export type MfaMethod = 'none' | 'totp' | 'email';

export interface MfaStatus {
  method: MfaMethod;
  /** This session has done it. */
  satisfied: boolean;
  /** Until when (ms since the epoch) sensitive actions need no new verification; null: verify first. */
  stepUpUntil: number | null;
  /** How to verify again for a sensitive action. */
  stepUpWith: 'totp' | 'email';
}

export function mfaStatus(f: MfaFacts, c: SessionClaims, now = Date.now()): MfaStatus {
  // Email codes, once on, always apply: an authenticator added outside Wren (straight through the
  // Auth API with just the password) doesn't replace them. Turning them off needs a verified session.
  const method: MfaMethod = f.email ? 'email' : f.factors > 0 ? 'totp' : 'none';
  const emailAt = f.emailVerifiedAt ? f.emailVerifiedAt.getTime() : 0;
  const aal2 = c.aal === 'aal2';
  const satisfied = method === 'email' ? emailAt > 0 : method === 'totp' ? aal2 : true;
  const stepUpWith = method === 'totp' ? 'totp' : 'email';
  const secondFactorAt = aal2 ? Math.max(0, ...(c.amr ?? []).filter((a) => SECOND_FACTOR.has(a.method)).map((a) => a.timestamp * 1000)) : 0;
  const verifiedAt = stepUpWith === 'totp' ? secondFactorAt : emailAt;
  const until = satisfied && verifiedAt > 0 ? verifiedAt + STEP_UP_SECONDS * 1000 : 0;
  return { method, satisfied, stepUpUntil: until > now ? until : null, stepUpWith };
}

/** "t•••@example.com": enough to recognise the address without showing it. */
export function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain) return '';
  return `${name.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(name.length - 1, 4)))}@${domain}`;
}
