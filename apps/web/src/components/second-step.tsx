'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/client/api';
import { sendEmailCode, verifyEmailCode, verifyRecoveryCode, verifyTotp, type MfaInfo } from '@/lib/client/mfa';
import { Button, Input, Label } from './ui';

/**
 * Asks for the second step: a code from the authenticator app (or a recovery code), or an emailed
 * code. `purpose` decides which: signing in uses the account's method; confirming a sensitive
 * action ("step_up") uses `stepUpWith` and never spends a recovery code.
 */
export function SecondStep({ mfa, purpose, onDone }: { mfa: MfaInfo; purpose: 'sign_in' | 'step_up'; onDone: () => void }) {
  const via = purpose === 'sign_in' ? (mfa.method === 'email' ? 'email' : 'totp') : mfa.stepUpWith;
  const [mode, setMode] = useState<'totp' | 'recovery' | 'email'>(via);
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

  async function send() {
    setError(null);
    try {
      await sendEmailCode(purpose);
      setNote(`We sent a code to ${mfa.emailHint}.`);
      setCooldown(60);
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'code_cooldown') {
        // One was sent a moment ago (e.g. on a reload): it still works.
        setNote(`A code was sent to ${mfa.emailHint} a moment ago.`);
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
      if (mode === 'totp') await verifyTotp(code);
      else if (mode === 'recovery') await verifyRecoveryCode(code);
      else await verifyEmailCode(code);
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
        {purpose === 'sign_in' && via === 'totp' && mfa.recoveryCodes && (
          <button type="button" onClick={() => (setMode(mode === 'totp' ? 'recovery' : 'totp'), setCode(''), setError(null))} className="transition-colors hover:text-text">
            {mode === 'totp' ? 'Use a recovery code instead' : 'Use the authenticator app instead'}
          </button>
        )}
      </div>
    </form>
  );
}
