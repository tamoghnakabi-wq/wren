import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import { guardWindow, onOrigin } from '../src/main/window-guard';

// Wren's window shows Wren's own origin only. 0.1.39 stopped navigations the page started but not a
// redirect on the way (a Wren address answering with a redirect elsewhere loaded that page in the
// window), and replaced the whole window with the offline page when anything inside it failed.

const ORIGIN = 'https://wren-agents.vercel.app';

function fakeWindow() {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  let opener: ((d: { url: string }) => { action: string }) | undefined;
  const wc = {
    on: (event: string, fn: (...a: unknown[]) => void) => (handlers.set(event, fn), wc),
    setWindowOpenHandler: (fn: typeof opener) => void (opener = fn),
  };
  const opened: string[] = [];
  const offline: string[] = [];
  guardWindow(wc as unknown as WebContents, { origin: ORIGIN, openExternal: (u) => opened.push(u), offline: (_d, u) => offline.push(u) });
  const fire = (event: string, url: string, ...rest: unknown[]) => {
    let prevented = false;
    const fn = handlers.get(event);
    if (!fn) throw new Error(`no ${event} handler`);
    fn({ url, preventDefault: () => (prevented = true) }, url, ...rest);
    return prevented;
  };
  return { fire, opened, offline, open: (url: string) => opener!({ url }), handlers };
}

describe('the window stays on Wren', () => {
  it('a redirect to another site is stopped and opened in the browser', () => {
    const w = fakeWindow();
    expect(w.fire('will-redirect', 'https://evil.example/login')).toBe(true);
    expect(w.opened).toEqual(['https://evil.example/login']);
  });

  it('a redirect within Wren goes ahead', () => {
    const w = fakeWindow();
    expect(w.fire('will-redirect', `${ORIGIN}/login?next=%2Fapp`)).toBe(false);
    expect(w.opened).toEqual([]);
  });

  it('navigations elsewhere are stopped; only web links go to the browser', () => {
    const w = fakeWindow();
    expect(w.fire('will-navigate', 'https://github.com/x')).toBe(true);
    expect(w.fire('will-navigate', 'file:///etc/passwd')).toBe(true);
    expect(w.fire('will-navigate', 'not a url')).toBe(true);
    expect(w.fire('will-navigate', `${ORIGIN}/app/settings`)).toBe(false);
    expect(w.opened).toEqual(['https://github.com/x']);
  });

  it('a look-alike origin is not Wren', () => {
    expect(onOrigin('https://wren-agents.vercel.app.evil.example/', ORIGIN)).toBe(false);
    expect(onOrigin('http://wren-agents.vercel.app/', ORIGIN)).toBe(false);
    expect(onOrigin('https://wren-agents.vercel.app:444/', ORIGIN)).toBe(false);
    expect(onOrigin('https://wren-agents.vercel.app/app', ORIGIN)).toBe(true);
  });

  it('new windows never open inside Wren', () => {
    const w = fakeWindow();
    expect(w.open('https://example.com/')).toEqual({ action: 'deny' });
    expect(w.open('javascript:alert(1)')).toEqual({ action: 'deny' });
    expect(w.opened).toEqual(['https://example.com/']);
  });
});

describe('the offline page', () => {
  it('replaces the window only when Wren’s own page failed to load', () => {
    const w = fakeWindow();
    w.handlers.get('did-fail-load')!({}, -106, 'ERR_INTERNET_DISCONNECTED', `${ORIGIN}/app`, true);
    w.handlers.get('did-fail-load')!({}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://frame.example/', false);
    w.handlers.get('did-fail-load')!({}, -3, 'ERR_ABORTED', `${ORIGIN}/app`, true);
    expect(w.offline).toEqual([`${ORIGIN}/app`]);
  });
});
