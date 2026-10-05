'use client';

import Link from 'next/link';
import { Apple, Download, MonitorDown } from 'lucide-react';
import { useSyncExternalStore } from 'react';

function noSubscribe() {
  return () => {};
}
function detectOs(): 'mac' | 'win' | 'other' {
  const ua = navigator.userAgent;
  return /Mac/.test(ua) && !/iPhone|iPad/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'win' : 'other';
}

// Shows the right desktop download for the visitor's OS (links to /download,
// which only lists installers that actually exist on GitHub Releases).
export function DownloadButtons({ compact }: { compact?: boolean }) {
  // The visitor's OS, read after hydration (the server renders the neutral button).
  const os = useSyncExternalStore(noSubscribe, detectOs, () => 'other' as const);
  const label = os === 'mac' ? 'Download for Mac' : os === 'win' ? 'Download for Windows' : 'Desktop apps';
  const Icon = os === 'mac' ? Apple : os === 'win' ? MonitorDown : Download;
  return (
    <Link href="/download" className={`inline-flex items-center gap-2 rounded-xl border border-border bg-surface font-medium shadow-sm transition-[background-color,border-color,transform] duration-150 hover:border-border-strong hover:bg-surface-2 active:scale-[0.97] ${compact ? 'h-12 px-5 text-[15px]' : 'h-12 px-6'}`}>
      <Icon className="h-4.5 w-4.5" aria-hidden /> {label}
    </Link>
  );
}
