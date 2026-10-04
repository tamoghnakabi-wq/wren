import { Suspense } from 'react';
import { AuthForm, AuthShell } from '@/components/auth-form';

export const metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <AuthShell>
      <Suspense>
        <AuthForm mode="login" />
      </Suspense>
    </AuthShell>
  );
}
