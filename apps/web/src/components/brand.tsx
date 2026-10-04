import { cx } from '@/lib/cx';

/** Wren mark: a small bird in a single stroke-free shape. */
export function WrenMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cx('h-7 w-7', className)} aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--brand)" />
      <path
        d="M8.5 19.2c0-4.6 3.6-8.3 8.1-8.3 2.2 0 4 .8 5.3 2.2l3.7-1.6-1.9 3.4c.4 1 .6 2.1.6 3.3 0 .5 0 .9-.1 1.4l2 2.6-3.2-.6c-1.5 2.1-3.9 3.4-6.6 3.4H8.5l2.6-2.4c-1.6-.9-2.6-2-2.6-3.4Z"
        fill="#fff"
      />
      <circle cx="20.2" cy="15.6" r="1.25" fill="var(--brand)" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <WrenMark />
      <span className="text-[17px]">Wren</span>
    </span>
  );
}

export function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx('h-5 w-5', className)} fill="currentColor" aria-hidden>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.29-1.69-1.29-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}
