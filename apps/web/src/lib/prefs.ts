// What <html> carries from this browser's saved preferences: the theme (class `dark`; System follows
// the OS) and collapsed panes (`data-sidebar`, `data-details`, see lib/client/layout.ts).
//
// PREFS_SCRIPT runs inline in <head>, before the first paint. ThemeWatcher applies the same again
// (applyStoredPrefs) once React has the page: when part of a page renders differently in the browser
// than on the server, React builds the page again and resets <html>'s attributes, which turned the
// app light (Settings after a full load, outside UTC). Keep the two in step (test/settings-hydration.test.ts).

export const PREFS_SCRIPT = `try{var r=document.documentElement,t=localStorage.getItem('wren-theme')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);r.classList.toggle('dark',d);if(localStorage.getItem('wren-sidebar')==='collapsed')r.dataset.sidebar='collapsed';if(localStorage.getItem('wren-details')==='hidden')r.dataset.details='hidden'}catch(e){}`;

export interface PrefsRoot {
  classList: { toggle(token: string, force?: boolean): boolean };
  dataset: Record<string, string | undefined>;
}

export function applyStoredPrefs(root: PrefsRoot, storage: Pick<Storage, 'getItem'>, prefersDark: boolean) {
  const t = storage.getItem('wren-theme') || 'system';
  root.classList.toggle('dark', t === 'dark' || (t === 'system' && prefersDark));
  if (storage.getItem('wren-sidebar') === 'collapsed') root.dataset.sidebar = 'collapsed';
  if (storage.getItem('wren-details') === 'hidden') root.dataset.details = 'hidden';
}
