import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyStoredPrefs, PREFS_SCRIPT } from '../src/lib/prefs';

// Settings turned light after a full page load (Wren's Settings… menu item, or a reload) for anyone
// outside UTC. The server (UTC on Vercel) rendered a "Use UTC" button the browser didn't, so React
// built the page again and reset <html>, dropping the theme the inline script had set.
//
// React's first render in the browser uses the same server snapshots as the server, so the page is
// safe when rendering it in different time zones (and with different time-zone lists, as Node's and
// Chromium's can differ) gives the same HTML.

vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {}, refresh() {} }), usePathname: () => '/app/settings' }));
vi.mock('@/components/app/provider', () => ({
  useApp: () => ({ profile: { display_name: 'Tam', timezone: 'Australia/Melbourne' }, email: 'tam@example.test', devices: [], desktop: null }),
}));
vi.mock('@/components/app/security-settings', () => ({ SecuritySettings: () => null }));
vi.mock('@/components/app/push', () => ({ enablePush: async () => {}, forgetPushHere: async () => {}, pushState: () => 'default' }));
vi.mock('@/lib/client/api', () => ({ api: async () => ({}) }));
vi.mock('@/lib/client/supabase', () => ({ supabase: () => ({ auth: {} }) }));
vi.mock('@/lib/client/desktop', () => import('../src/lib/client/desktop'));
vi.mock('@/components/ui', () => import('../src/components/ui'));
vi.mock('@/lib/cx', () => import('../src/lib/cx'));

const realTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = realTz;
  vi.restoreAllMocks();
});

/** The Settings page's HTML as rendered with this time zone and list of zones (a fresh module each time). */
async function settingsHtml(tz: string, zones: string[]) {
  process.env.TZ = tz;
  vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(zones);
  vi.resetModules();
  const { default: SettingsPage } = await import('../src/app/app/settings/page');
  return renderToString(createElement(SettingsPage));
}

describe('the Settings page renders the same on the server and in the browser', () => {
  it('whatever the time zone of each (Vercel is in UTC)', async () => {
    const zones = ['Australia/Melbourne', 'Europe/London', 'UTC'];
    const server = await settingsHtml('UTC', zones);
    const browser = await settingsHtml('Australia/Melbourne', zones);
    expect(server).toContain('Australia/Melbourne'); // the saved zone is shown either way
    expect(browser).toBe(server);
  });

  it('whatever list of time zones each knows', async () => {
    const server = await settingsHtml('Australia/Melbourne', ['Australia/Melbourne', 'UTC']);
    const browser = await settingsHtml('Australia/Melbourne', ['Australia/Melbourne', 'America/Ciudad_Juarez', 'UTC']);
    expect(browser).toBe(server);
  });
});

/** Run the inline <head> script against stand-ins and report what it left on <html>. */
function runScript(stored: Record<string, string>, prefersDark: boolean) {
  const root = fakeRoot();
  new Function('document', 'localStorage', 'matchMedia', PREFS_SCRIPT)({ documentElement: root }, { getItem: (k: string) => stored[k] ?? null }, () => ({ matches: prefersDark }));
  return root.state();
}
function fakeRoot() {
  const classes = new Set<string>();
  const dataset: Record<string, string | undefined> = {};
  return {
    classList: { toggle: (c: string, on?: boolean) => ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c), classes.has(c)) },
    dataset,
    state: () => ({ dark: classes.has('dark'), ...dataset }),
  };
}

describe('the theme and panes are put back once React has the page', () => {
  const cases: [Record<string, string>, boolean][] = [
    [{}, true],
    [{}, false],
    [{ 'wren-theme': 'dark' }, false],
    [{ 'wren-theme': 'light' }, true],
    [{ 'wren-theme': 'system', 'wren-sidebar': 'collapsed' }, true],
    [{ 'wren-details': 'hidden', 'wren-sidebar': 'open' }, false],
  ];

  it('the same way the inline script sets them before the first paint', () => {
    for (const [stored, prefersDark] of cases) {
      const root = fakeRoot();
      applyStoredPrefs(root, { getItem: (k) => stored[k] ?? null }, prefersDark);
      expect(root.state(), JSON.stringify({ stored, prefersDark })).toEqual(runScript(stored, prefersDark));
    }
  });

  it('dark when System is chosen (the default) and the OS is dark, with a collapsed sidebar kept', () => {
    const root = fakeRoot(); // as React leaves <html> after building the page again: nothing of ours on it
    applyStoredPrefs(root, { getItem: (k) => ({ 'wren-sidebar': 'collapsed' })[k] ?? null }, true);
    expect(root.state()).toEqual({ dark: true, sidebar: 'collapsed' });
  });
});
