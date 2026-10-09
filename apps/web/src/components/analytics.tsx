'use client';

import { Analytics } from '@vercel/analytics/next';
import { usePathname } from 'next/navigation';
import { useEffect, useSyncExternalStore } from 'react';
import { ANALYTICS_PAGES, analyticsEvent } from '@/lib/analytics';

/**
 * Wraps every page. Vercel Web Analytics loads on the public site only (W-141, W-142): its script is fetched
 * on its own and runs with the page's full access, so it never loads where people sign in, in the app (task
 * and file ids, pairing codes), or in the desktop app's window (whose page can change this computer's
 * settings). Once loaded it stays in the document, so a page that isn't public is never drawn there: the
 * site's links to sign-in are full page loads, and any other way there (back, forward) draws nothing and
 * loads the page afresh (W-146). Whether this document loaded it is this module's own state, not something
 * the script could change (the SDK's `window.va`).
 */
export function SiteAnalytics({ children }: { children: React.ReactNode }) {
  const isPublic = ANALYTICS_PAGES.has(usePathname());
  // Known only after mount (the server renders no analytics either).
  const inBrowser = useSyncExternalStore(noSubscribe, () => !window.wren, () => false);
  const tainted = useSyncExternalStore(onLoaded, () => loaded, () => false);
  const leave = tainted && !isPublic;
  useEffect(() => {
    if (leave) window.location.reload();
  }, [leave]);
  return (
    <>
      {leave ? null : children}
      {isPublic && inBrowser ? <LoadAnalytics /> : null}
    </>
  );
}

/** Set once this document has loaded the analytics script; it stays set until the document is replaced. */
let loaded = false;
const listeners = new Set<() => void>();
function onLoaded(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function LoadAnalytics() {
  useEffect(() => {
    loaded = true;
    for (const l of listeners) l();
  }, []);
  return <Analytics beforeSend={analyticsEvent} />;
}

function noSubscribe() {
  return () => {};
}
