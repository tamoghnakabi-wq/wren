import { Suspense } from 'react';
import { AuthForm, AuthShell } from '@/components/auth-form';

export const metadata = { title: 'Create account' };

export default function SignupPage() {
  return (
    <AuthShell>
      <Suspense>
        <AuthForm mode="signup" />
      </Suspense>
    </AuthShell>
  );
}
