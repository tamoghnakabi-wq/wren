'use client';

import { BellRing, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { desktop } from '@/lib/client/desktop';
import { Button } from '../ui';

const KEY = 'wren-push-dismissed';

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export type PushState = 'unsupported' | 'needs-install' | 'default' | 'granted' | 'denied';

export function pushState(): PushState {
  if (typeof window === 'undefined') return 'unsupported';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return ios && !standalone ? 'needs-install' : 'unsupported';
  return Notification.permission as PushState;
}

export async function enablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm as PushState;
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!key) return 'unsupported';
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
  await api('/api/push/subscribe', { body: sub.toJSON() });
  return 'granted';
}

/** Gentle one-time banner offering notifications (not shown inside the desktop app). */
export function PushPrompt() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (desktop()) {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
      return;
    }
    const s = pushState();
    if (s === 'granted') {
      // keep the subscription fresh on this device
      enablePush().catch(() => {});
      return;
    }
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(KEY) === '1';
    } catch {}
    const t = setTimeout(() => setShow(!dismissed && s === 'default'), 4000);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem(KEY, '1');
    } catch {}
  };
  return (
    <div className="animate-in fixed inset-x-3 bottom-20 z-40 mx-auto max-w-md rounded-2xl border border-border bg-surface p-4 shadow-pop lg:right-6 lg:bottom-6 lg:left-auto">
      <div className="flex gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <BellRing className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Get notified on this device</p>
          <p className="mt-0.5 text-[13px] text-muted">Know when an agent finishes, has a question, or needs your approval — even when Wren is closed.</p>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await enablePush();
                } finally {
                  setBusy(false);
                  dismiss();
                }
              }}
            >
              Turn on
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              Not now
            </Button>
          </div>
        </div>
        <button onClick={dismiss} className="self-start text-faint" aria-label="Dismiss">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
