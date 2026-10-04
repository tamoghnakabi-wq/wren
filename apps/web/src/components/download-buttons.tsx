'use client';

import Link from 'next/link';
import { Apple, Download, MonitorDown } from 'lucide-react';
import { useEffect, useState } from 'react';

// Shows the right desktop download for the visitor's OS (links to /download,
// which only lists installers that actually exist on GitHub Releases).
export function DownloadButtons({ compact }: { compact?: boolean }) {
  const [os, setOs] = useState<'mac' | 'win' | 'other'>('other');
  useEffect(() => {
    const ua = navigator.userAgent;
    setOs(/Mac/.test(ua) && !/iPhone|iPad/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'win' : 'other');
  }, []);
  const label = os === 'mac' ? 'Download for Mac' : os === 'win' ? 'Download for Windows' : 'Desktop apps';
  const Icon = os === 'mac' ? Apple : os === 'win' ? MonitorDown : Download;
  return (
    <Link href="/download" className={`inline-flex items-center gap-2 rounded-xl border border-border bg-surface font-medium shadow-sm hover:bg-surface-2 ${compact ? 'h-12 px-5 text-[15px]' : 'h-12 px-6'}`}>
      <Icon className="h-4.5 w-4.5" /> {label}
    </Link>
  );
}
