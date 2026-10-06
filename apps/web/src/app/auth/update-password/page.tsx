'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { StepUpProvider } from '@/components/app/step-up';
import { AuthShell } from '@/components/auth-form';
import { Button, Input, Label, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/client/api';
import { mfaInfo } from '@/lib/client/mfa';

export default function UpdatePasswordPage() {
  return (
    <AuthShell>
      <StepUpProvider>
        <UpdatePassword />
      </StepUpProvider>
    </AuthShell>
  );
}

function UpdatePassword() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The reset link alone isn't enough with two-step sign-in on: finish the second step first. The
  // server enforces this (POST /api/account/password, and for email codes Supabase's endpoint is
  // closed to anything else); the form just doesn't show until it's done.
  useEffect(() => {
    mfaInfo().then((m) => {
      if (!m) router.replace('/login');
      else if (!m.satisfied) router.replace('/auth/mfa?next=/auth/update-password');
      else setReady(true);
    });
  }, [router]);
  if (!ready)
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          // Asks to confirm with the second step first if it wasn't just done.
          await api('/api/account/password', { body: { password } });
          router.replace('/app');
        } catch (err) {
          setError((err as ApiError).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <div>
        <Label htmlFor="pw">New password</Label>
        <Input id="pw" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {error && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
      <Button type="submit" className="w-full" loading={busy}>
        Save password
      </Button>
    </form>
  );
}
