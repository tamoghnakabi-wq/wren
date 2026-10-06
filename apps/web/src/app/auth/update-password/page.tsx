'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthShell } from '@/components/auth-form';
import { Button, Input, Label } from '@/components/ui';
import { mfaError, mfaInfo } from '@/lib/client/mfa';
import { supabase } from '@/lib/client/supabase';

export default function UpdatePasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // With two-step sign-in on, the reset link alone isn't enough: Supabase only changes the password
  // of a session that finished the second step, so do that first.
  useEffect(() => {
    mfaInfo().then((m) => m && !m.satisfied && router.replace('/auth/mfa?next=/auth/update-password'));
  }, [router]);
  return (
    <AuthShell>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const { error } = await supabase().auth.updateUser({ password });
          setBusy(false);
          if (error?.code === 'insufficient_aal') router.replace('/auth/mfa?next=/auth/update-password');
          else if (error) setError(mfaError(error));
          else router.replace('/app');
        }}
      >
        <h1 className="text-xl font-semibold">Choose a new password</h1>
        <div>
          <Label htmlFor="pw">New password</Label>
          <Input id="pw" type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</p>}
        <Button type="submit" className="w-full" loading={busy}>
          Save password
        </Button>
      </form>
    </AuthShell>
  );
}
