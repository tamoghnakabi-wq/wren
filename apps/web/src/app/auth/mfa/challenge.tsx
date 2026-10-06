'use client';

import { ShieldCheck } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SecondStep } from '@/components/second-step';
import { Spinner } from '@/components/ui';
import { mfaInfo, type MfaInfo } from '@/lib/client/mfa';
import { safeNext } from '@/lib/next-path';
import { supabase } from '@/lib/client/supabase';


export function MfaChallenge() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [mfa, setMfa] = useState<MfaInfo | null>(null);

  useEffect(() => {
    mfaInfo().then((m) => {
      if (!m) return router.replace(`/login?next=${encodeURIComponent(next)}`);
      if (m.satisfied) return router.replace(next);
      setMfa(m);
    });
  }, [router, next]);

  if (!mfa)
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  return (
    <div className="space-y-5">
      <div>
        <ShieldCheck className="h-8 w-8 text-brand" aria-hidden />
        <h1 className="mt-3 text-xl font-semibold">Two-step sign-in</h1>
      </div>
      <SecondStep
        mfa={mfa}
        purpose="sign_in"
        onDone={() => {
          router.replace(next);
          router.refresh();
        }}
      />
      <button
        type="button"
        className="text-[13px] text-muted transition-colors hover:text-text"
        onClick={async () => {
          await supabase().auth.signOut({ scope: 'local' });
          router.replace('/login');
        }}
      >
        Sign out and use another account
      </button>
    </div>
  );
}
