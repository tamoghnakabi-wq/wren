'use client';

import { useSyncExternalStore } from 'react';

// Collapsible panes: the left sidebar (icon rail when collapsed) and the task details panel.
// The state is an attribute on <html> (set before paint by the root layout's inline script,
// from localStorage), so CSS variants (`rail:`, `details-off:`) lay the page out without a
// flash and React only reads it for labels.

export type Pane = 'sidebar' | 'details';

const PANES: Record<Pane, { attr: 'sidebar' | 'details'; value: string; key: string }> = {
  sidebar: { attr: 'sidebar', value: 'collapsed', key: 'wren-sidebar' },
  details: { attr: 'details', value: 'hidden', key: 'wren-details' },
};
const EVENT = 'wren-layout';

export function isCollapsed(p: Pane): boolean {
  return document.documentElement.dataset[PANES[p].attr] === PANES[p].value;
}

export function togglePane(p: Pane) {
  const { attr, value, key } = PANES[p];
  const root = document.documentElement;
  const collapse = root.dataset[attr] !== value;
  if (collapse) root.dataset[attr] = value;
  else delete root.dataset[attr];
  try {
    localStorage.setItem(key, collapse ? value : 'open');
  } catch {
    /* storage unavailable: the choice lasts for this page */
  }
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

/** Whether a pane is collapsed (false during server render; the layout itself never waits on this). */
export function usePaneCollapsed(p: Pane): boolean {
  return useSyncExternalStore(subscribe, () => isCollapsed(p), () => false);
}

/** ⌘\ / Ctrl+\ toggles the sidebar; with Shift, the task details. */
export function paneShortcut(e: KeyboardEvent): Pane | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.code !== 'Backslash') return null;
  return e.shiftKey ? 'details' : 'sidebar';
}
