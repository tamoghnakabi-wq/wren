import { redirect } from 'next/navigation';
import { supabaseServer } from '@/lib/auth';
import { AppProvider } from '@/components/app/provider';
import { Shell } from '@/components/app/shell';
import { ConfirmProvider, ToastProvider } from '@/components/ui';

export const metadata = { title: 'App' };

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const sb = await supabaseServer();
  const { data } = await sb.auth.getClaims();
  const claims = data?.claims;
  if (!claims?.sub) redirect('/login');
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppProvider userId={claims.sub} email={String(claims.email ?? '')}>
          <Shell>{children}</Shell>
        </AppProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
