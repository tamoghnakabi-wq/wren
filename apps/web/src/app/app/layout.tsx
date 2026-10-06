import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { supabaseServer, userFromClaims } from '@/lib/auth';
import { mfaStatusFor } from '@/lib/mfa';
import { AppProvider } from '@/components/app/provider';
import { Shell } from '@/components/app/shell';
import { StepUpProvider } from '@/components/app/step-up';
import { ConfirmProvider, ToastProvider } from '@/components/ui';

export const metadata = { title: 'App' };

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const sb = await supabaseServer();
  const { data } = await sb.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) redirect('/login');
  // Two-step sign-in not finished in this session: finish it first (the API and the database
  // refuse everything until then anyway).
  const status = await mfaStatusFor(userFromClaims(claims as Record<string, unknown>)!);
  if (!status.satisfied) {
    const path = (await headers()).get('x-wren-path') ?? '/app';
    redirect(`/auth/mfa?next=${encodeURIComponent(path.startsWith('/app') ? path : '/app')}`);
  }
  return (
    <ToastProvider>
      <ConfirmProvider>
        <StepUpProvider>
          <AppProvider userId={claims.sub} email={String(claims.email ?? '')}>
            <Shell>{children}</Shell>
          </AppProvider>
        </StepUpProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
