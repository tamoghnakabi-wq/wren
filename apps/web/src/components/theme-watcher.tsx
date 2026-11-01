'use client';

import { useEffect, useLayoutEffect } from 'react';
import { applyStoredPrefs } from '@/lib/prefs';

/**
 * Keeps <html> showing this browser's saved theme and panes. Once React has the page, they are applied
 * again before it is drawn: if React had to build the page again (part of it rendered differently than
 * on the server), it reset <html> and dropped what the inline script set. With the System theme, it
 * also follows the OS switching between light and dark while Wren is open.
 */
export function ThemeWatcher() {
  useLayoutEffect(() => {
    try {
      applyStoredPrefs(document.documentElement, localStorage, matchMedia('(prefers-color-scheme: dark)').matches);
    } catch {
      /* storage unavailable: the inline script's result stands */
    }
  }, []);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      let t = 'system';
      try {
        t = localStorage.getItem('wren-theme') ?? 'system';
      } catch {}
      if (t === 'system') document.documentElement.classList.toggle('dark', mq.matches);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return null;
}
