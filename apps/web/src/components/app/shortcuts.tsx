'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { desktop } from '@/lib/client/desktop';

// Keyboard shortcuts across the app (after T3 Code's): ⌥⌘N a new task; in the desktop app, which has no browser
// around it, ⌘[ / ⌘] back and forward and ⌘1–⌘9 the sidebar's active tasks (in a browser those keys are the
// browser's own, so they're left alone there); `?` lists them all.

/** Asks the shell to open the shortcuts list (the palette's "Keyboard shortcuts"). */
export const SHORTCUTS_EVENT = 'wren:shortcuts';
export const openShortcuts = () => window.dispatchEvent(new Event(SHORTCUTS_EVENT));

/** Whether a key press happened while typing (a field, a text area, something editable). */
function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

/** The shortcuts themselves; `tasks` are the sidebar's active tasks, in order (⌘1 is the first). */
export function useShortcuts(tasks: string[], onShortcuts: () => void) {
  const router = useRouter();
  const list = useRef(tasks);
  useEffect(() => {
    list.current = tasks;
  }, [tasks]);
  useEffect(() => {
    const inApp = !!desktop();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const mod = e.metaKey || e.ctrlKey;
      // ⌥⌘N / Ctrl+Alt+N: a new task (⌘N too in the desktop app, where no browser window would open).
      if (mod && e.code === 'KeyN' && !e.shiftKey && (e.altKey || inApp)) {
        e.preventDefault();
        router.push('/app?compose=1');
        return;
      }
      if (inApp && mod && !e.altKey && !e.shiftKey) {
        if (e.key === '[' || e.key === ']') {
          e.preventDefault();
          if (e.key === '[') router.back();
          else router.forward();
          return;
        }
        if (/^[1-9]$/.test(e.key)) {
          const id = list.current[Number(e.key) - 1];
          if (id) {
            e.preventDefault();
            router.push(`/app/s/${id}`);
          }
          return;
        }
      }
      if (e.key === '?' && !mod && !e.altKey && !typing(e)) {
        e.preventDefault();
        onShortcuts();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [router, onShortcuts]);
}

/** Every shortcut, for the list `?` opens. */
export function shortcutList(mac: boolean, inApp: boolean): { group: string; keys: string; what: string }[] {
  const m = mac ? '⌘' : 'Ctrl+';
  const alt = mac ? '⌥' : 'Alt+';
  return [
    { group: 'Anywhere', keys: `${m}K`, what: 'Search tasks, agents and pages' },
    { group: 'Anywhere', keys: inApp ? `${m}N` : `${alt}${m}N`, what: 'New task' },
    { group: 'Anywhere', keys: `${m}\\`, what: 'Collapse or expand the sidebar' },
    ...(inApp
      ? [
          { group: 'Anywhere', keys: `${m}1 – ${m}9`, what: 'Open an active task (as listed in the sidebar)' },
          { group: 'Anywhere', keys: `${m}[  ${m}]`, what: 'Back, forward' },
        ]
      : []),
    { group: 'Anywhere', keys: '?', what: 'This list' },
    { group: 'Writing a message', keys: 'Enter', what: 'Send (Shift+Enter for a new line)' },
    { group: 'Writing a message', keys: '↑', what: 'In an empty box: your last message again' },
    { group: 'Writing a message', keys: `${m}S`, what: 'Put the draft aside, or bring it back in an empty box' },
    { group: 'In a task', keys: `${mac ? '⇧⌘' : 'Ctrl+Shift+'}\\`, what: 'Show or hide the details beside it' },
    { group: 'In a task', keys: 'Select text', what: 'Quote it in your reply' },
  ];
}
