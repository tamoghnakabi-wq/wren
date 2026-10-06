import { describe, expect, it } from 'vitest';
import { maskEmail, mfaStatus, STEP_UP_SECONDS, type MfaFacts } from '../src/lib/mfa-rules';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const sec = (msAgo: number) => Math.floor((NOW - msAgo) / 1000);
const none: MfaFacts = { factors: 0, totp: 0, recoveryCodes: false, email: false, emailVerifiedAt: null };
const totp: MfaFacts = { ...none, factors: 2, totp: 1, recoveryCodes: true };
const email: MfaFacts = { ...none, email: true };
const pw = { method: 'password', timestamp: sec(60_000) };

describe('two-step sign-in rules', () => {
  it('asks nothing more of accounts without two-step sign-in', () => {
    expect(mfaStatus(none, { aal: 'aal1', amr: [pw] }, NOW)).toMatchObject({ method: 'none', satisfied: true, stepUpWith: 'email', stepUpUntil: null });
  });

  it('authenticator accounts need an aal2 session', () => {
    expect(mfaStatus(totp, { aal: 'aal1', amr: [pw] }, NOW)).toMatchObject({ method: 'totp', satisfied: false, stepUpUntil: null });
    expect(mfaStatus(totp, { aal: 'aal2', amr: [{ method: 'totp', timestamp: sec(30_000) }, pw] }, NOW)).toMatchObject({ satisfied: true, stepUpWith: 'totp' });
  });

  it('recovery codes alone still count as two-step sign-in (Supabase asks for aal2 too)', () => {
    const onlyCodes = { ...none, factors: 1, recoveryCodes: true };
    expect(mfaStatus(onlyCodes, { aal: 'aal1', amr: [pw] }, NOW).satisfied).toBe(false);
  });

  it('a claimed aal without the database facts can’t lower what an account needs', () => {
    // The facts come from the database, not from the client: email-code accounts ignore the JWT's aal.
    expect(mfaStatus(email, { aal: 'aal2', amr: [{ method: 'totp', timestamp: sec(1000) }] }, NOW).satisfied).toBe(false);
  });

  it('email-code accounts need this session to have passed an email code', () => {
    expect(mfaStatus(email, { aal: 'aal1', amr: [pw] }, NOW)).toMatchObject({ method: 'email', satisfied: false });
    expect(mfaStatus({ ...email, emailVerifiedAt: new Date(NOW - 30_000) }, { aal: 'aal1', amr: [pw] }, NOW)).toMatchObject({ satisfied: true, stepUpWith: 'email' });
  });

  it('an authenticator added behind an email-code account’s back doesn’t replace the email code', () => {
    // Password-only attacker enrols a TOTP factor straight through the Auth API and verifies it (aal2).
    const hijacked = { ...email, factors: 1, totp: 1 };
    expect(mfaStatus(hijacked, { aal: 'aal2', amr: [{ method: 'totp', timestamp: sec(5000) }, pw] }, NOW)).toMatchObject({ method: 'email', satisfied: false });
  });

  it('step-up: a second step in the last ten minutes, from the factor sign-in uses', () => {
    const fresh = { aal: 'aal2', amr: [{ method: 'totp', timestamp: sec(60_000) }, pw] };
    const stale = { aal: 'aal2', amr: [{ method: 'totp', timestamp: sec((STEP_UP_SECONDS + 60) * 1000) }, pw] };
    expect(mfaStatus(totp, fresh, NOW).stepUpUntil).toBe((fresh.amr[0].timestamp + STEP_UP_SECONDS) * 1000);
    expect(mfaStatus(totp, stale, NOW).stepUpUntil).toBeNull();
    // A recovery code just used to get in counts (so a lost phone can be removed)…
    expect(mfaStatus(totp, { aal: 'aal2', amr: [{ method: 'mfa/recovery_code', timestamp: sec(30_000) }, pw] }, NOW).stepUpUntil).not.toBeNull();
    // …a fresh password doesn't.
    expect(mfaStatus(totp, { aal: 'aal2', amr: [{ method: 'password', timestamp: sec(1000) }, { method: 'totp', timestamp: sec(3_600_000) }] }, NOW).stepUpUntil).toBeNull();
    // An aal1 session never has a valid step-up, whatever amr says.
    expect(mfaStatus(totp, { aal: 'aal1', amr: [{ method: 'totp', timestamp: sec(1000) }] }, NOW).stepUpUntil).toBeNull();
  });

  it('step-up for email and password-only accounts is a recent email code in this session', () => {
    expect(mfaStatus({ ...email, emailVerifiedAt: new Date(NOW - 60_000) }, { aal: 'aal1' }, NOW).stepUpUntil).toBe(NOW - 60_000 + STEP_UP_SECONDS * 1000);
    expect(mfaStatus({ ...email, emailVerifiedAt: new Date(NOW - (STEP_UP_SECONDS + 1) * 1000) }, { aal: 'aal1' }, NOW).stepUpUntil).toBeNull();
    expect(mfaStatus({ ...none, emailVerifiedAt: new Date(NOW - 60_000) }, { aal: 'aal1', amr: [pw] }, NOW).stepUpUntil).not.toBeNull();
    expect(mfaStatus(none, { aal: 'aal1', amr: [pw] }, NOW).stepUpUntil).toBeNull();
  });

  it('masks the email address', () => {
    expect(maskEmail('tamoghna@example.com')).toBe('t••••@example.com');
    expect(maskEmail('a@b.co')).toBe('a•@b.co');
    expect(maskEmail('nope')).toBe('');
  });
});
