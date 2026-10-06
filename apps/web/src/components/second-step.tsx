'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/client/api';
import { sendEmailCode, totpFactors, verifyEmailCode, verifyRecoveryCode, verifyTotp, type MfaInfo, type TotpFactor } from '@/lib/client/mfa';
import { Button, Input, Label, Select } from './ui';

/**
 * Asks for the second step: a code from the authenticator app (or a recovery code), or an emailed
 * code. `purpose` decides which: signing in uses the account's method; confirming a sensitive
 * action ("step_up") uses `stepUpWith` and doesn't spend a recovery code while an app is there.
 * With several authenticator apps the user picks the one they have.
 */
export function SecondStep({ mfa, purpose, onDone }: { mfa: MfaInfo; purpose: 'sign_in' | 'step_up'; onDone: () => void }) {
  const via = purpose === 'sign_in' ? (mfa.method === 'email' ? 'email' : 'totp') : mfa.stepUpWith;
  // Recovery codes with no app left (Wren removes them with the last app, so only from before that).
  const onlyCodes = via === 'totp' && mfa.totp === 0 && mfa.recoveryCodes;
  const [mode, setMode] = useState<'totp' | 'recovery' | 'email'>(onlyCodes ? 'recovery' : via);
  const [factors, setFactors] = useState<TotpFactor[]>([]);
  const [factorId, setFactorId] = useState('');
  const challenge = useRef<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const sentOnce = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    if (via !== 'totp' || onlyCodes) return;
    let cancelled = false;
    totpFactors().then(
      (f) => {
        if (cancelled) return;
        setFactors(f);
        setFactorId(f[0]?.id ?? '');
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [via, onlyCodes]);

  async function send() {
    setError(null);
    try {
      const r = await sendEmailCode(purpose);
      challenge.current = r.challengeId;
      // Not sent again: this session's code went out a moment ago (e.g. before a reload) and still works.
      setNote(r.sent ? `We sent a code to ${mfa.emailHint}.` : `A code was sent to ${mfa.emailHint} a moment ago.`);
      setCooldown(r.wait);
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'code_cooldown') {
        // Another tab or device asked for a code just now, for something else: wait, then ask again.
        setNote('A code was just sent from another tab or device. Ask for a new one here when the timer runs out.');
        setCooldown(Number(/(\d+) seconds/.exec(err.message)?.[1] ?? 60));
      } else setError(err.message);
    }
    input.current?.focus();
  }

  useEffect(() => {
    if (mode === 'email' && !sentOnce.current) {
      sentOnce.current = true;
      void send();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'totp') await verifyTotp(code, factorId || undefined);
      else if (mode === 'recovery') await verifyRecoveryCode(code);
      else if (!challenge.current) throw new Error('Ask for a new code first.');
      else await verifyEmailCode(code, challenge.current, purpose);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setCode('');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const label = mode === 'totp' ? 'Code from your authenticator app' : mode === 'recovery' ? 'Recovery code' : 'Code from the email';
  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-muted">
        {mode === 'totp' && 'Open your authenticator app and enter the 6-digit code for Wren.'}
        {mode === 'recovery' && 'Enter one of the recovery codes you saved when you set up two-step sign-in. Each code works once.'}
        {mode === 'email' && (note ?? `We’re sending a code to ${mfa.emailHint}…`)}
      </p>
      {mode === 'totp' && factors.length > 1 && (
        <div>
          <Label htmlFor="second-step-factor">Authenticator app</Label>
          <Select id="second-step-factor" value={factorId} onChange={(e) => (setFactorId(e.target.value), setError(null))}>
            {factors.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div>
        <Label htmlFor="second-step-code">{label}</Label>
        <Input
          ref={input}
          id="second-step-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="one-time-code"
          inputMode={mode === 'recovery' ? 'text' : 'numeric'}
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          required
          maxLength={mode === 'recovery' ? 24 : 10}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? 'second-step-error' : undefined}
          className="font-mono tracking-widest"
        />
      </div>
      {error && (
        <p id="second-step-error" role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      )}
      <Button type="submit" className="w-full" loading={busy}>
        {purpose === 'sign_in' ? 'Continue' : 'Confirm'}
      </Button>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted">
        {mode === 'email' && (
          <button type="button" onClick={send} disabled={cooldown > 0} className="transition-colors hover:text-text disabled:opacity-50">
            {cooldown > 0 ? `Send a new code in ${cooldown}s` : 'Send a new code'}
          </button>
        )}
        {purpose === 'sign_in' && via === 'totp' && mfa.recoveryCodes && !onlyCodes && (
          <button type="button" onClick={() => (setMode(mode === 'totp' ? 'recovery' : 'totp'), setCode(''), setError(null))} className="transition-colors hover:text-text">
            {mode === 'totp' ? 'Use a recovery code instead' : 'Use the authenticator app instead'}
          </button>
        )}
      </div>
    </form>
  );
}
