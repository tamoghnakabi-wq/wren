'use client';

import Link from 'next/link';
import { Apple, Download, MonitorDown } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { cx } from '@/lib/cx';

function noSubscribe() {
  return () => {};
}
function detectOs(): 'mac' | 'win' | 'other' {
  const ua = navigator.userAgent;
  return /Mac/.test(ua) && !/iPhone|iPad/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'win' : 'other';
}

// Shows the right desktop download for the visitor's OS (links to /download,
// which only lists installers that actually exist on GitHub Releases).
export function DownloadButtons({ tone = 'paper' }: { tone?: 'paper' | 'night' }) {
  // The visitor's OS, read after hydration (the server renders the neutral button).
  const os = useSyncExternalStore(noSubscribe, detectOs, () => 'other' as const);
  const label = os === 'mac' ? 'Download for Mac' : os === 'win' ? 'Download for Windows' : 'Desktop apps';
  const Icon = os === 'mac' ? Apple : os === 'win' ? MonitorDown : Download;
  return (
    <Link
      href="/download"
      className={cx(
        'inline-flex h-12 items-center gap-2 rounded-[10px] border px-5 text-[15px] font-semibold transition-[background-color,border-color,transform] duration-150 active:scale-[0.97]',
        tone === 'night' ? 'border-night-line bg-night-2 text-night-text hover:border-night-muted/50 hover:bg-night-3' : 'border-border bg-surface shadow-sm hover:border-border-strong hover:bg-surface-2',
      )}
    >
      <Icon className="h-4.5 w-4.5" aria-hidden /> {label}
    </Link>
  );
}
