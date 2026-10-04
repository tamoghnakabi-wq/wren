'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, Laptop, ShieldCheck } from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { Button, Card, Input, Spinner, useToast } from '@/components/ui';
import { api } from '@/lib/client/api';

export default function LinkPage() {
  return (
    <Suspense fallback={<Spinner className="mx-auto mt-24" />}>
      <LinkDevice />
    </Suspense>
  );
}

function LinkDevice() {
  const params = useSearchParams();
  const toast = useToast();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [info, setInfo] = useState<{ valid: boolean; device?: { name: string; platform: string } } | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (code.replace(/[^A-Za-z0-9]/g, '').length !== 8) return setInfo(null);
    api<{ valid: boolean; device?: { name: string; platform: string } }>(`/api/devices/approve?code=${encodeURIComponent(code)}`).then(setInfo).catch(() => setInfo({ valid: false }));
  }, [code]);

  if (done)
    return (
      <Card className="mx-auto mt-10 max-w-md p-8 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-success" />
        <h1 className="mt-4 text-xl font-semibold">{info?.device?.name ?? 'Your computer'} is linked</h1>
        <p className="mt-2 text-sm text-muted">You can close this tab and return to the Wren app. Agents can now work on that computer with the permissions you set there.</p>
        <Link href="/app" className="mt-6 inline-block">
          <Button variant="secondary">Go to Wren</Button>
        </Link>
      </Card>
    );

  return (
    <Card className="mx-auto mt-10 max-w-md p-8">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-subtle">
        <Laptop className="h-6 w-6" />
      </div>
      <h1 className="mt-4 text-xl font-semibold">Link a computer</h1>
      <p className="mt-1.5 text-sm text-muted">Enter the code shown in the Wren desktop app. Only approve codes you just started yourself.</p>
      <Input className="mt-5 text-center font-mono text-lg tracking-[0.3em] uppercase" value={code} maxLength={9} placeholder="ABCD-EF23" onChange={(e) => setCode(e.target.value.toUpperCase())} aria-label="Code" />
      {info && !info.valid && <p className="mt-2 text-[13px] text-danger">That code is invalid or expired.</p>}
      {info?.valid && (
        <div className="mt-4 rounded-xl bg-bg-subtle p-3 text-sm">
          <p className="font-medium">{info.device?.name}</p>
          <p className="text-[12.5px] text-muted">{info.device?.platform === 'darwin' ? 'macOS' : info.device?.platform === 'win32' ? 'Windows' : info.device?.platform} · wants to link to your account</p>
        </div>
      )}
      <Button
        className="mt-5 w-full"
        disabled={!info?.valid}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api('/api/devices/approve', { body: { code } });
            setDone(true);
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
