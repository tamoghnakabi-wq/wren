'use client';

import { Analytics, type BeforeSendEvent } from '@vercel/analytics/next';

/**
 * Vercel Web Analytics, with every page's query string and hash left out before anything is recorded:
 * some addresses carry one-time codes (a desktop pairing link, the sign-in return).
 */
export function SiteAnalytics() {
  return <Analytics beforeSend={(event: BeforeSendEvent) => ({ ...event, url: event.url.split(/[?#]/)[0] })} />;
}
