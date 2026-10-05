'use client';

import { useSearchParams } from 'next/navigation';
import { CheckCircle2, Laptop, ShieldCheck } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { Button, ButtonLink, Card, Input, Skeleton, useToast } from '@/components/ui';
import { api } from '@/lib/client/api';

type Lookup = { code: string; valid: boolean; device?: { name: string; platform: string } };

export default function LinkPage() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto mt-10 h-72 max-w-md rounded-2xl" />}>
      <LinkDevice />
    </Suspense>
  );
}

function LinkDevice() {
  const params = useSearchParams();
  const toast = useToast();
  const [code, setCode] = useState(params.get('code') ?? '');
  // A lookup result belongs to the code it was made for, and only shows while that is the code.
  const [info, setInfo] = useState<Lookup | null>(null);
  const [done, setDone] = useState<Lookup | null>(null);
  const [busy, setBusy] = useState(false);

  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const complete = normalized.length === 8;
  useEffect(() => {
    if (!complete) return;
    let current = true; // a slower answer for an earlier code is dropped
    api<Omit<Lookup, 'code'>>(`/api/devices/approve?code=${encodeURIComponent(normalized)}`)
      .then((r) => current && setInfo({ ...r, code: normalized }))
      .catch(() => current && setInfo({ valid: false, code: normalized }));
    return () => {
      current = false;
    };
  }, [normalized, complete]);
  // Only the details of exactly this code (looked up, not still loading) are shown or approved.
  const shown = complete && info?.code === normalized ? info : null;
  const looking = complete && !shown;

  if (done)
    return (
      <Card className="mx-auto mt-10 max-w-md p-8 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
        <h1 className="mt-4 text-xl font-semibold">{done.device?.name ?? 'Your computer'} is linked</h1>
        <p className="mt-2 text-sm text-muted">You can close this tab and return to the Wren app. Agents can now work on that computer with the permissions you set there.</p>
        <ButtonLink href="/app" variant="secondary" className="mt-6">
          Go to Wren
        </ButtonLink>
      </Card>
    );

  return (
    <Card className="mx-auto mt-10 max-w-md p-8">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-subtle">
        <Laptop className="h-6 w-6" />
      </div>
      <h1 className="mt-4 text-xl font-semibold">Link a computer</h1>
      <p className="mt-1.5 text-sm text-muted">Enter the code shown in the Wren desktop app. Only approve codes you just started yourself.</p>
      <Input className="mt-5 text-center font-mono text-lg tracking-[0.3em] uppercase" value={code} maxLength={9} placeholder="ABCD-EF23" readOnly={busy} onChange={(e) => setCode(e.target.value.toUpperCase())} aria-label="Code" />
      {looking && <Skeleton className="mt-4 h-[58px] rounded-xl" />}
      {shown && !shown.valid && <p className="mt-2 text-[13px] text-danger">That code is invalid or expired.</p>}
      {shown?.valid && (
        <div className="mt-4 rounded-xl bg-bg-subtle p-3 text-sm">
          <p className="font-medium">{shown.device?.name}</p>
          <p className="text-[12.5px] text-muted">{shown.device?.platform === 'darwin' ? 'macOS' : shown.device?.platform === 'win32' ? 'Windows' : shown.device?.platform} · wants to link to your account</p>
        </div>
      )}
      <Button
        className="mt-5 w-full"
        disabled={!shown?.valid || busy}
        loading={busy}
        onClick={async () => {
          const approving = shown;
          if (!approving?.valid) return;
          setBusy(true);
          try {
            // The code whose computer is on screen, never whatever the box holds by now.
            await api('/api/devices/approve', { body: { code: approving.code } });
            setDone(approving);
          } catch (e) {
            toast((e as Error).message, 'error');
          } finally {
            setBusy(false);
          }
        }}
      >
        <ShieldCheck className="h-4 w-4" /> Link this computer
      </Button>
    </Card>
  );
}
