'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Eye, EyeOff, MailCheck } from 'lucide-react';
import { useState } from 'react';
import { supabase } from '@/lib/client/supabase';
import { Logo } from './brand';
import { Button, Input, Label } from './ui';

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Link href="/" className="mb-8" aria-label="Wren home">
        <Logo />
      </Link>
      <div className="w-full max-w-[400px] rounded-3xl border border-border bg-surface p-7 shadow-pop sm:p-8">{children}</div>
      <p className="mt-6 max-w-sm text-center text-[12px] text-faint">
        By continuing you agree to the <Link href="/legal" className="underline">terms and privacy notice</Link>.
      </p>
    </div>
  );
}

export function AuthForm({ mode }: { mode: 'login' | 'signup' }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next')?.startsWith('/app') ? params.get('next')! : '/app';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get('error'));
  const [sent, setSent] = useState<'confirm' | 'reset' | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const sb = supabase();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: { data: { name: name.trim() }, emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
        });
        if (error) throw error;
        if (data.session) {
          router.replace(next);
          router.refresh();
        } else setSent('confirm');
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(next);
        router.refresh();
      }
    } catch (err) {
      const msg = (err as Error).message;
      setError(/Email not confirmed/i.test(msg) ? 'Please confirm your email first — check your inbox for the link.' : /Invalid login/i.test(msg) ? 'Wrong email or password.' : msg);
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!email) return setError('Enter your email first.');
    setBusy(true);
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: `${origin}/auth/callback?next=/auth/update-password` });
    setBusy(false);
    if (error) setError(error.message);
    else setSent('reset');
  }

  if (sent)
    return (
      <div className="animate-in text-center" role="status">
        <MailCheck className="mx-auto h-10 w-10 text-brand" aria-hidden />
        <h1 className="mt-4 text-xl font-semibold">Check your email</h1>
        <p className="mt-2 text-sm text-muted">
          {sent === 'confirm' ? 'We sent a confirmation link to ' : 'We sent a password reset link to '}
          <b className="text-text">{email}</b>.
        </p>
        <Button variant="ghost" className="mt-4" onClick={() => setSent(null)}>
          Back
        </Button>
      </div>
    );

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h1>
        <p className="mt-1 text-sm text-muted">{mode === 'signup' ? 'Your own team of AI agents, everywhere you are.' : 'Sign in to your agents.'}</p>
      </div>
      {mode === 'signup' && (
        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </div>
      )}
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!error || undefined} aria-describedby={error ? 'auth-error' : undefined} />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            required
            minLength={mode === 'signup' ? 8 : 1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="pr-11"
            aria-invalid={!!error || undefined}
            aria-describedby={[mode === 'signup' ? 'password-hint' : '', error ? 'auth-error' : ''].filter(Boolean).join(' ') || undefined}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-xl text-faint transition-colors hover:text-text"
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
          >
            {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          </button>
        </div>
        {mode === 'signup' && (
          <p id="password-hint" className="mt-1 text-[12px] text-faint">
            At least 8 characters.
          </p>
        )}
      </div>
      {error && (
        <p id="auth-error" role="alert" className="animate-in rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {error}
        </p>
      )}
      <Button type="submit" className="w-full" size="lg" loading={busy}>
        {mode === 'signup' ? 'Create account' : 'Sign in'}
      </Button>
      <div className="flex items-center justify-between text-[13px] text-muted">
        {mode === 'login' ? (
          <>
            <button type="button" onClick={reset} disabled={busy} className="transition-colors hover:text-text disabled:opacity-50">
              Forgot password?
            </button>
            <Link href={`/signup${next !== '/app' ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-text">
              Create account
            </Link>
          </>
        ) : (
          <span>
            Already have an account?{' '}
            <Link href={`/login${next !== '/app' ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-text">
              Sign in
            </Link>
          </span>
        )}
      </div>
    </form>
  );
}
