import { Suspense } from 'react';
import { AuthShell } from '@/components/auth-form';
import { MfaChallenge } from './challenge';

export const metadata = { title: 'Two-step sign-in' };

export default function MfaPage() {
  return (
    <AuthShell>
      <Suspense>
        <MfaChallenge />
      </Suspense>
    </AuthShell>
  );
}
