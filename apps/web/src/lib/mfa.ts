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
// needs on top: a code only counts for the session that asked for it, wrong guesses are capped,
// sending is rate-limited, and a passed code is recorded against the session (`mfa_session_checks`).

/** A code is accepted for this long after it was sent (Supabase may keep it valid longer). */
const CODE_WINDOW_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;
const MAX_SENDS_PER_HOUR = 5;

export type CodePurpose = 'sign_in' | 'step_up' | 'enable';

export async function mfaFacts(u: AuthUser): Promise<MfaFacts> {
  const [r] = await db()`select * from public.wren_mfa_state(${u.id}, ${u.sessionId ?? null})`;
  return {
    factors: Number(r?.factors ?? 0),
    totp: Number(r?.totp ?? 0),
    recoveryCodes: !!r?.recovery_codes,
    email: !!r?.email,
    emailVerifiedAt: r?.email_verified_at ? new Date(r.email_verified_at) : null,
  };
}

export async function mfaStatusFor(u: AuthUser): Promise<MfaStatus & { facts: MfaFacts }> {
  const facts = await mfaFacts(u);
  return { ...mfaStatus(facts, { aal: u.aal, amr: u.amr }), facts };
}

/** A fresh Supabase Auth client that keeps nothing: each code check signs in on its own. */
function authClient() {
  return createClient(env.supabaseUrl, env.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

/** Ask Supabase to email a code. Which purposes a session may ask for depends on where it stands. */
export async function sendEmailCode(u: AuthUser, purpose: CodePurpose): Promise<void> {
  if (!u.sessionId || !u.email) throw new HttpError(400, 'This sign-in can’t receive codes. Sign in again.', 'invalid');
  const s = await mfaStatusFor(u);
  const allowed =
    purpose === 'sign_in' ? s.method === 'email' && !s.satisfied : purpose === 'step_up' ? s.method !== 'totp' && s.satisfied : !s.facts.email && s.facts.factors === 0 && s.satisfied;
  if (!allowed) throw new HttpError(409, purpose === 'step_up' && s.method === 'totp' ? 'Use your authenticator app to confirm.' : 'An email code isn’t needed for this.', 'not_needed');
  const sql = db();
  const wait = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`mfa-email:${u.id}`}))`;
    const [last] = await tx`select extract(epoch from now() - sent_at)::float as ago from public.mfa_email_requests where user_id = ${u.id} order by sent_at desc limit 1`;
    if (last && last.ago < RESEND_SECONDS) return Math.ceil(RESEND_SECONDS - last.ago);
    const [{ n }] = await tx`select count(*)::int as n from public.mfa_email_requests where user_id = ${u.id} and sent_at > now() - interval '1 hour'`;
    if (n >= MAX_SENDS_PER_HOUR) return -1;
    await tx`insert into public.mfa_email_requests (user_id, session_id, purpose) values (${u.id}, ${u.sessionId!}, ${purpose})`;
    return 0;
  });
  if (wait > 0) throw new HttpError(429, `A code was just sent. You can ask for another in ${wait} seconds.`, 'code_cooldown');
  if (wait < 0) throw new HttpError(429, 'Too many codes were sent in the last hour. Try again later.', 'code_limit');
  const { error } = await authClient().auth.signInWithOtp({ email: u.email, options: { shouldCreateUser: false } });
  if (error) throw new HttpError(502, 'The code couldn’t be sent. Try again in a minute.', 'email_failed');
}

/** Check a code with Supabase; on success record this session as verified by email. */
export async function verifyEmailCode(u: AuthUser, rawCode: string): Promise<CodePurpose> {
  const code = rawCode.replace(/\s+/g, '');
  if (!u.sessionId || !u.email) throw new HttpError(400, 'Sign in again.', 'invalid');
  if (!/^\d{6,10}$/.test(code)) throw new HttpError(400, 'Enter the code from the email.', 'code_invalid');
  const sql = db();
  // Count the attempt before checking it, under a row lock: parallel guesses share the cap.
  const req = await sql.begin(async (tx) => {
    const [r] = await tx`select id, purpose, attempts from public.mfa_email_requests
      where user_id = ${u.id} and session_id = ${u.sessionId!} and used_at is null and sent_at > now() - make_interval(mins => ${CODE_WINDOW_MINUTES})
      order by sent_at desc limit 1 for update`;
    if (!r) return null;
    if (r.attempts >= MAX_ATTEMPTS) return { ...r, exhausted: true };
    await tx`update public.mfa_email_requests set attempts = attempts + 1 where id = ${r.id}`;
    return r;
  });
  if (!req) throw new HttpError(400, 'That code has expired. Ask for a new one.', 'code_expired');
  if (req.exhausted) throw new HttpError(429, 'Too many wrong codes. Ask for a new one.', 'code_attempts');
  if (req.purpose === 'enable' && (await mfaFacts(u)).factors > 0) throw new HttpError(409, 'Email codes can’t be turned on while an authenticator app is set up.', 'not_needed');

  const { data, error } = await authClient().auth.verifyOtp({ email: u.email, token: code, type: 'email' });
  if (error || !data.session) throw new HttpError(400, 'That code isn’t right.', 'code_invalid');
  // Checking the code also signed the user in once more: end that extra session straight away.
  await fetch(`${env.supabaseUrl}/auth/v1/logout?scope=local`, { method: 'POST', headers: { apikey: env.supabaseKey, authorization: `Bearer ${data.session.access_token}` } }).catch(() => {});

  await sql.begin(async (tx) => {
    await tx`update public.mfa_email_requests set used_at = now() where id = ${req.id}`;
    await tx`insert into public.mfa_session_checks (session_id, user_id, email_verified_at) values (${u.sessionId!}, ${u.id}, now())
      on conflict (session_id) do update set email_verified_at = now() where public.mfa_session_checks.user_id = excluded.user_id`;
    if (req.purpose === 'enable') await tx`insert into public.mfa_email (user_id) values (${u.id}) on conflict do nothing`;
  });
  return req.purpose as CodePurpose;
}

/** Turn email codes off (the caller has verified recently). */
export async function disableEmailCodes(u: AuthUser): Promise<void> {
  await db()`delete from public.mfa_email where user_id = ${u.id}`;
}
