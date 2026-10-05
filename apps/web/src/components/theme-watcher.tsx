'use client';

import { useEffect } from 'react';

/** With the System theme, follow the OS switching between light and dark while Wren is open. */
export function ThemeWatcher() {
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
