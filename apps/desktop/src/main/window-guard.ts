import type { WebContents } from 'electron';

// Wren's window shows Wren only: its own origin. Anything else opens in the user's browser, whether the
// page follows a link, opens a new window, or a Wren address redirects elsewhere on the way. A foreign
// page in Wren's window would have no address bar to give it away (it would never get window.wren,
// which is checked by origin, but it could look like Wren and ask for a password).

/** Whether `url` is on `origin` (anything that isn't a URL is not). */
export function onOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export interface GuardOptions {
  origin: string;
  openExternal: (url: string) => void;
  /** Wren's own page couldn't load: show the offline page. */
  offline: (description: string, url: string) => void;
}

export function guardWindow(wc: WebContents, o: GuardOptions) {
  const elsewhere = (e: { preventDefault(): void }, url: string) => {
    if (onOrigin(url, o.origin)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) o.openExternal(url);
  };
  wc.on('will-navigate', (e, url) => elsewhere(e, url));
  // A navigation that starts on Wren's origin and is redirected (a 30x) never fires will-navigate again.
  wc.on('will-redirect', (e, url) => elsewhere(e, url));
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) o.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    // -3: a navigation that was called off (e.g. by the guard above). Something inside the page that
    // failed (a frame) isn't the window's page failing.
    if (code === -3 || !isMainFrame) return;
    o.offline(description, url);
  });
}
