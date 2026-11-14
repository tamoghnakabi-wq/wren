'use client';

import Link from 'next/link';
import { Download, LayoutTemplate, Maximize2 } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cx } from '@/components/ui';

// Pages agents make (task.show_page), shown in a sandboxed frame: scripts run, but in an opaque origin with
// nothing of Wren's (lib/pages.ts has the policy). The frame says how tall its page is; only messages from
// this frame's own window count, and only a number is read from them.

const subscribeClass = (cb: () => void) => {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => mo.disconnect();
};
const darkNow = () => document.documentElement.classList.contains('dark');

/** Whether the app is showing its dark theme now. */
export function useDark(): boolean {
  return useSyncExternalStore(subscribeClass, darkNow, () => false);
}

export function PageFrame({ id, title, fill, max = 720, className }: { id: string; title: string; /** Fill the space it's given instead of fitting the page. */ fill?: boolean; max?: number; className?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const dark = useDark();
  const [height, setHeight] = useState(240);
  useEffect(() => {
    if (fill) return;
    const on = (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const d = e.data as { wrenPage?: unknown; height?: unknown } | null;
      if (!d || d.wrenPage !== 'height') return;
      const h = Number(d.height);
      if (Number.isFinite(h)) setHeight(Math.max(80, Math.min(Math.round(h), max)));
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [fill, max]);
  return (
    <iframe
      ref={ref}
      // A new theme loads the page again with Wren's other colours.
      src={`/api/pages/${id}?theme=${dark ? 'dark' : 'light'}`}
      sandbox="allow-scripts"
      title={title}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={cx('block w-full border-0 bg-surface', className)}
      style={fill ? undefined : { height }}
    />
  );
}

/** A page in the timeline: its title, the page itself, and ways to open it larger or keep it. */
export function PageCard({ id, title }: { id: string; title: string }) {
  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
      <figcaption className="flex items-center gap-2 border-b border-border py-1.5 pr-1.5 pl-3.5">
        <LayoutTemplate className="h-4 w-4 shrink-0 text-faint" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</span>
        <Link href={`/app/page/${id}`} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-muted transition-colors hover:bg-bg-subtle hover:text-text">
          <Maximize2 className="h-3.5 w-3.5" aria-hidden /> Open
        </Link>
        <a href={`/api/files/${id}?download`} className="inline-flex items-center rounded-md p-1.5 text-muted transition-colors hover:bg-bg-subtle hover:text-text" aria-label={`Download ${title}`} title="Download">
          <Download className="h-3.5 w-3.5" aria-hidden />
        </a>
      </figcaption>
      <PageFrame id={id} title={title} />
    </figure>
  );
}
