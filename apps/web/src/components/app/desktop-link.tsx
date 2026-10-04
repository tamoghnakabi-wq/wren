'use client';

import { Laptop, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/client/api';
import { desktop } from '@/lib/client/desktop';
import { Button, useToast } from '../ui';
import { useApp } from './provider';

/** Inside the desktop app: one click links this computer to the signed-in account. */
export function DesktopLinkBanner() {
  const { desktop: status } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const d = desktop();
  if (!d || !status || status.linked) return null;
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-brand/30 bg-brand-soft/60 p-4">
      <Laptop className="h-6 w-6 text-brand" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Let agents work on this computer</p>
        <p className="text-[13px] text-muted">Link {status.deviceName ?? 'this computer'} to your account. You choose which folders agents may use in Settings.</p>
      </div>
      <Button
        size="sm"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const { userCode } = await d.link();
            await api('/api/devices/approve', { body: { code: userCode } });
            toast('Linking…');
          } catch (e) {
            toast((e as Error).message, 'error');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Link this computer
      </Button>
    </div>
  );
}
