'use client';

import { api, type ApiError } from './api';
import { supabase } from './supabase';

// Browser side of two-step sign-in. Authenticator apps and recovery codes go straight to Supabase
// Auth (which raises the session to aal2); email codes go through Wren's API (see lib/mfa.ts).

export interface MfaInfo {
  method: 'none' | 'totp' | 'email';
  satisfied: boolean;
  stepUpUntil: number | null;
  stepUpWith: 'totp' | 'email';
  totp: number;
  recoveryCodes: boolean;
  email: boolean;
  emailHint: string;
}

export async function mfaInfo(): Promise<MfaInfo | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) return null;
  return ((await res.json()) as { mfa: MfaInfo }).mfa;
}

/** Plain-language versions of Supabase Auth's MFA error codes. */
export function mfaError(e: { code?: string; message?: string } | null | undefined): string {
  switch (e?.code) {
    case 'mfa_verification_failed':
    case 'invalid_credentials':
      return 'That code isn’t right. Check it and try again.';
    case 'mfa_challenge_expired':
      return 'That took too long. Enter a new code.';
    case 'mfa_recovery_codes_locked':
    case 'over_request_rate_limit':
    case 'too_many_requests':
      return 'Too many tries. Wait a few minutes and try again.';
    case 'mfa_recovery_codes_verify_not_enabled':
    case 'mfa_recovery_codes_enroll_not_enabled':
      return 'Recovery codes aren’t turned on for this service yet.';
    case 'insufficient_aal':
      return 'Confirm it’s you with your authenticator app first.';
    default:
      return e?.message || 'Something went wrong. Try again.';
  }
}

export interface TotpFactor {
  id: string;
  name: string;
}

/** The account's authenticator apps, oldest first (sign-in lets the user pick one when there are several). */
export async function totpFactors(): Promise<TotpFactor[]> {
  const { data, error } = await supabase().auth.mfa.listFactors();
  if (error) throw new Error(mfaError(error));
  return data.totp
    .filter((x) => x.status === 'verified')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((f, i) => ({ id: f.id, name: f.friendly_name || (i ? `Authenticator app ${i + 1}` : 'Authenticator app') }));
}

export async function verifyTotp(code: string, factorId?: string): Promise<void> {
  const id = factorId ?? (await totpFactors())[0]?.id;
  if (!id) throw new Error('No authenticator app is set up.');
  const { error } = await supabase().auth.mfa.challengeAndVerify({ factorId: id, code: code.replace(/\s+/g, '') });
  if (error) throw new Error(mfaError(error));
}

export async function verifyRecoveryCode(code: string): Promise<void> {
  const { error } = await supabase().auth.mfa.recoveryCodes.verify({ code });
  if (error) throw new Error(mfaError(error));
}

export type CodePurpose = 'sign_in' | 'step_up' | 'enable';
export interface CodeSent {
  challengeId: string;
  /** False: this session's code for the same thing went out moments ago and still works. */
  sent: boolean;
  /** Seconds until another code can be sent. */
  wait: number;
}

/** Ask for a code. If this session's code is still on its way (a second click), wait for it. */
export async function sendEmailCode(purpose: CodePurpose): Promise<CodeSent> {
  for (let i = 0; ; i++) {
    try {
      return await api<CodeSent>('/api/mfa/email/send', { body: { purpose } });
    } catch (e) {
      if ((e as ApiError).code !== 'code_sending' || i >= 20) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
/** Check a code for the request it was sent for. */
export const verifyEmailCode = (code: string, challengeId: string, purpose: CodePurpose) =>
  api<{ ok: true; purpose: CodePurpose }>('/api/mfa/email/verify', { body: { code, challengeId, purpose } });

/** Recovery codes come in canonical form (16 lowercase characters); show them in groups of four. */
export const formatRecoveryCode = (c: string) => c.toUpperCase().match(/.{1,4}/g)?.join('-') ?? c;
