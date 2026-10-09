'use client';

import { Analytics } from '@vercel/analytics/next';
import { usePathname } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import { ANALYTICS_PAGES, analyticsEvent } from '@/lib/analytics';

/**
 * Vercel Web Analytics, on the public site only (W-141, W-142). Its script is fetched on its own and
 * runs with the page's full access, so it never loads where people sign in, in the app (task and file
 * ids, pairing codes), or in the desktop app's window (whose page can change this computer's settings).
 * Once loaded it stays in the document, so a page that isn't public never runs next to it: links from
 * the site to sign-in are full page loads, and any other way there (back, forward) loads the page afresh.
 */
export function SiteAnalytics() {
  const isPublic = ANALYTICS_PAGES.has(usePathname());
  // Known only after mount (the server renders nothing here either).
  const inBrowser = useSyncExternalStore(noSubscribe, () => !window.wren, () => false);
  useEffect(() => {
    if (!isPublic && 'va' in window) window.location.reload();
  }, [isPublic]);
  return isPublic && inBrowser ? <Analytics beforeSend={analyticsEvent} /> : null;
}

function noSubscribe() {
  return () => {};
}
