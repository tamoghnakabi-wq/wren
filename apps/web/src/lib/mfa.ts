import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from './auth';
import { HttpError } from './auth';
import { db } from './db';
import { env } from './env';
import { mfaStatus, type MfaFacts, type MfaStatus } from './mfa-rules';

// Server side of two-step sign-in: the account's MFA facts, and email codes.
//
// Email codes are Supabase Auth email OTPs: Supabase generates the code, sends it (the "Magic Link"
// email template shows it), expires it and checks it (`verifyOtp`). Wren adds what an MFA factor
// needs on top: a code only counts for the request (session, purpose, address) that asked for it,
// wrong guesses are capped, sending is rate-limited, and a passed code is recorded against the
// session (`mfa_session_checks`).

/** A code is accepted for this long after it was sent (Supabase may keep it valid longer). */
const CODE_WINDOW_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const MAX_SENDS_PER_HOUR = 5;

export type CodePurpose = 'sign_in' | 'step_up' | 'enable';

export interface MfaState extends MfaFacts {
  /** The account's current address, from Supabase Auth (a JWT's `email` can be out of date). */
  userEmail: string;
  /** Supabase Auth still has this session: signing out or revoking it ends it at once. */
  sessionAlive: boolean;
}

export async function mfaFacts(u: AuthUser): Promise<MfaState> {
  const [r] = await db()`select * from public.wren_mfa_state(${u.id}, ${u.sessionId ?? null})`;
  return {
    factors: Number(r?.factors ?? 0),
    totp: Number(r?.totp ?? 0),
    recoveryCodes: !!r?.recovery_codes,
    email: !!r?.email,
    emailVerifiedAt: r?.email_verified_at ? new Date(r.email_verified_at) : null,
    userEmail: String(r?.user_email ?? ''),
    sessionAlive: !!r?.session_alive,
  };
}

export type MfaStatusFor = MfaStatus & { facts: MfaState };

export async function mfaStatusFor(u: AuthUser): Promise<MfaStatusFor> {
  const facts = await mfaFacts(u);
  return { ...mfaStatus(facts, { aal: u.aal, amr: u.amr }), facts };
}

/** Calls to Supabase Auth give up after this long (a send holds the account's send lock meanwhile). */
const AUTH_TIMEOUT_MS = 15000;

/** A fresh Supabase Auth client that keeps nothing: each code check signs in on its own. */
function authClient() {
  return createClient(env.supabaseUrl, env.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) }) },
  });
}

const jwtClaims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { sub?: string; session_id?: string };

export interface CodeSent {
  /** The request the code belongs to: checking the code needs it. */
  challengeId: string;
  /** False when this session's code for the same thing went out moments ago (it still works). */
  sent: boolean;
  /** Seconds until another code can be sent. */
  wait: number;
}

/** Ask Supabase to email a code. Which purposes a session may ask for depends on where it stands. */
export async function sendEmailCode(u: AuthUser, purpose: CodePurpose): Promise<CodeSent> {
  const s = await mfaStatusFor(u);
  const email = s.facts.userEmail;
  if (!u.sessionId || !email || !s.facts.sessionAlive) throw new HttpError(400, 'This sign-in can’t receive codes. Sign in again.', 'invalid');
  const allowed =
    purpose === 'sign_in' ? s.method === 'email' && !s.satisfied : purpose === 'step_up' ? s.method !== 'totp' && s.satisfied : !s.facts.email && s.facts.factors === 0 && s.satisfied;
  if (!allowed) throw new HttpError(409, purpose === 'step_up' && s.method === 'totp' ? 'Use your authenticator app to confirm.' : 'An email code isn’t needed for this.', 'not_needed');
  // One send at a time per account, from the rate checks through Supabase's answer (W-101): the
  // order of requests is the order Supabase made their codes in, and a request only becomes visible
  // (to verify, or to hand out again) once Supabase has sent its code (W-100).
  const r = await db().begin(async (tx): Promise<{ challengeId?: string; sent?: boolean; wait: number; failed?: boolean }> => {
    await tx`select pg_advisory_xact_lock(hashtext(${`mfa-email:${u.id}`}))`;
    const [last] = await tx`select id, session_id, purpose, email, used_at, superseded_at, extract(epoch from now() - sent_at)::float as ago
      from public.mfa_email_requests where user_id = ${u.id} order by sent_at desc limit 1`;
    if (last && last.ago < RESEND_SECONDS) {
      const wait = Math.ceil(RESEND_SECONDS - last.ago);
      // This session's code for the same thing went out moments ago (a reload, a second click): use that one.
      if (last.session_id === u.sessionId && last.purpose === purpose && last.email === email && !last.used_at && !last.superseded_at) return { challengeId: last.id as string, sent: false, wait };
      return { wait };
    }
    const [{ n }] = await tx`select count(*)::int as n from public.mfa_email_requests where user_id = ${u.id} and sent_at > now() - interval '1 hour'`;
    if (n >= MAX_SENDS_PER_HOUR) return { wait: -1 };
    const [row] = await tx`insert into public.mfa_email_requests (user_id, session_id, purpose, email) values (${u.id}, ${u.sessionId!}, ${purpose}, ${email}) returning id`;
    const { error } = await authClient().auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (error) {
      // Nothing was sent: this request can't be finished (an earlier code, if any, still can). It
      // still counts against the limits.
      await tx`update public.mfa_email_requests set superseded_at = now() where id = ${row.id}`;
      return { wait: RESEND_SECONDS, failed: true };
    }
    // Supabase keeps only the newest code for an account: older requests can't be finished any more.
    await tx`update public.mfa_email_requests set superseded_at = now() where user_id = ${u.id} and id <> ${row.id} and used_at is null and superseded_at is null`;
    return { challengeId: row.id as string, sent: true, wait: RESEND_SECONDS };
  });
  if (r.failed) throw new HttpError(502, 'The code couldn’t be sent. Try again in a minute.', 'email_failed');
  if (!r.challengeId) {
    if (r.wait < 0) throw new HttpError(429, 'Too many codes were sent in the last hour. Try again later.', 'code_limit');
    throw new HttpError(429, `A code was just sent. You can ask for another in ${r.wait} seconds.`, 'code_cooldown');
  }
  return { challengeId: r.challengeId, sent: !!r.sent, wait: r.wait };
}

/** Check a code with Supabase; on success record this session as verified by email. */
export async function verifyEmailCode(u: AuthUser, rawCode: string, challengeId: string, purpose: CodePurpose): Promise<CodePurpose> {
  const code = rawCode.replace(/\s+/g, '');
  if (!u.sessionId) throw new HttpError(400, 'Sign in again.', 'invalid');
  if (!/^\d{6,10}$/.test(code)) throw new HttpError(400, 'Enter the code from the email.', 'code_invalid');
  const sql = db();
  // Count the attempt before checking it, under a row lock: parallel guesses share the cap.
  const req = await sql.begin(async (tx) => {
    const [r] = await tx`select id, purpose, email, attempts, used_at, superseded_at, sent_at > now() - make_interval(mins => ${CODE_WINDOW_MINUTES}) as fresh
      from public.mfa_email_requests where id = ${challengeId} and user_id = ${u.id} and session_id = ${u.sessionId!} for update`;
    if (!r || r.used_at || !r.fresh) return { status: 'expired' as const };
    if (r.superseded_at) return { status: 'superseded' as const };
    if (r.purpose !== purpose) return { status: 'purpose' as const };
    if (r.attempts >= MAX_ATTEMPTS) return { status: 'exhausted' as const };
    await tx`update public.mfa_email_requests set attempts = attempts + 1 where id = ${r.id}`;
    return { status: 'ok' as const, id: r.id as string, email: r.email as string | null };
  });
  if (req.status === 'expired') throw new HttpError(400, 'That code has expired. Ask for a new one.', 'code_expired');
  if (req.status === 'superseded') throw new HttpError(400, 'A newer code was sent. Use the code from the newest email, or ask for a new one.', 'code_superseded');
  if (req.status === 'purpose') throw new HttpError(400, 'That code was sent for something else. Ask for a new one.', 'code_expired');
  if (req.status === 'exhausted') throw new HttpError(429, 'Too many wrong codes. Ask for a new one.', 'code_attempts');
  const facts = await mfaFacts(u);
  if (!facts.sessionAlive) throw new HttpError(401, 'This sign-in has ended. Sign in again.', 'session_ended');
  // The code went to the address the account had then; it only counts if that's still the address.
  if (!req.email || req.email !== facts.userEmail) throw new HttpError(400, 'Your email address changed since that code was sent. Ask for a new one.', 'code_expired');
  if (purpose === 'enable' && facts.factors > 0) throw new HttpError(409, 'Email codes can’t be turned on while an authenticator app is set up.', 'not_needed');

  const { data, error } = await authClient().auth.verifyOtp({ email: req.email, token: code, type: 'email' });
  if (error || !data.session || !data.user) throw new HttpError(400, 'That code isn’t right.', 'code_invalid');
  // Checking the code also signed the account in once more: that extra session ends with the check.
  const extra = jwtClaims(data.session.access_token);
  const owner = data.user.id;
  if (owner !== u.id || extra.sub !== u.id) {
    if (extra.session_id) await sql`select public.wren_end_otp_session(${owner}, ${extra.session_id})`.catch(() => {});
    throw new HttpError(400, 'That code isn’t right.', 'code_invalid');
  }

  // Recording: the extra session ends first and stays ended whatever happens next (W-97). Then,
  // under the request's row lock, everything is checked again as it is now (W-100): the request is
  // still the account's open one, this session still exists, the address is still the one the
  // code went to, and "enable" still has no authenticator to give way to.
  const outcome = await sql.begin(async (tx) => {
    const [{ ended }] = await tx`select public.wren_end_otp_session(${u.id}, ${extra.session_id ?? null}) as ended`;
    if (!ended) throw new HttpError(502, 'The code couldn’t be checked. Ask for a new one.', 'code_failed');
    const [open] = await tx`select id from public.mfa_email_requests where id = ${req.id} and used_at is null and superseded_at is null for update`;
    if (!open) return 'superseded' as const;
    const [now] = await tx`select * from public.wren_mfa_state(${u.id}, ${u.sessionId!})`;
    if (!now?.session_alive) return 'session' as const;
    if (now.user_email !== req.email) return 'email' as const;
    if (purpose === 'enable' && Number(now.factors) > 0) return 'factor' as const;
    await tx`update public.mfa_email_requests set used_at = now() where id = ${req.id}`;
    await tx`insert into public.mfa_session_checks (session_id, user_id, email_verified_at) values (${u.sessionId!}, ${u.id}, now())
      on conflict (session_id) do update set email_verified_at = now() where public.mfa_session_checks.user_id = excluded.user_id`;
    if (purpose === 'enable') await tx`insert into public.mfa_email (user_id) values (${u.id}) on conflict do nothing`;
    return 'ok' as const;
  });
  if (outcome === 'superseded') throw new HttpError(400, 'A newer code was sent. Use the code from the newest email, or ask for a new one.', 'code_superseded');
  if (outcome === 'session') throw new HttpError(401, 'This sign-in has ended. Sign in again.', 'session_ended');
  if (outcome === 'email') throw new HttpError(400, 'Your email address changed since that code was sent. Ask for a new one.', 'code_expired');
  if (outcome === 'factor') throw new HttpError(409, 'Email codes can’t be turned on while an authenticator app is set up.', 'not_needed');
  return purpose;
}

/** Turn email codes off (the caller has verified recently). */
export async function disableEmailCodes(u: AuthUser): Promise<void> {
  await db()`delete from public.mfa_email where user_id = ${u.id}`;
}

/**
 * Change the password through Supabase Auth with the caller's own token. With email codes on,
 * Supabase's endpoint is closed to everything else (trigger in migration 0010): the permit lets
 * exactly this session's change through.
 */
export async function changePassword(u: AuthUser, accessToken: string, password: string, emailCodes: boolean): Promise<void> {
  const sql = db();
  const [permit] = emailCodes ? await sql`insert into public.mfa_password_permits (user_id, session_id) values (${u.id}, ${u.sessionId!}) returning id` : [];
  try {
    const res = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
      method: 'PUT',
      headers: { apikey: env.supabaseKey, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) return;
    const e = (await res.json().catch(() => ({}))) as { error_code?: string; code?: string; msg?: string; message?: string };
    const code = e.error_code ?? e.code;
    if (code === 'same_password') throw new HttpError(400, 'That’s your current password. Choose a new one.', 'same_password');
    if (code === 'weak_password') throw new HttpError(400, e.msg ?? e.message ?? 'Choose a stronger password.', 'weak_password');
    if (code === 'insufficient_aal') throw new HttpError(403, 'Finish signing in first: enter your verification code.', 'mfa_required');
    throw new HttpError(502, 'The password couldn’t be changed. Try again.', 'password_failed');
  } finally {
    if (permit) await sql`delete from public.mfa_password_permits where id = ${permit.id}`;
  }
}
