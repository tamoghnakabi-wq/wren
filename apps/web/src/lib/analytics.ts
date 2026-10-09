import type { BeforeSendEvent } from '@vercel/analytics';

/** The public site: the only pages Vercel Web Analytics loads on (W-141, W-142). */
export const ANALYTICS_PAGES = new Set(['/', '/download', '/legal']);

/** What is recorded of a page view: public pages only, without query string or hash. */
export function analyticsEvent(event: BeforeSendEvent): BeforeSendEvent | null {
  const url = event.url.split(/[?#]/)[0];
  try {
    if (!ANALYTICS_PAGES.has(new URL(url).pathname)) return null;
  } catch {
    return null;
  }
  return { ...event, url };
}
