import Link from 'next/link';
import { cx } from '@/lib/cx';
import { Logo } from './brand';

/**
 * The site's top bar. `night` sits on the landing page's night hero (light text in both themes);
 * the default follows the theme.
 */
export function SiteNav({ tone = 'paper' }: { tone?: 'paper' | 'night' }) {
  const night = tone === 'night';
  const base = cx('rounded-lg px-3 py-2 transition-colors', night ? 'text-night-muted hover:text-night-text' : 'text-muted hover:text-text');
  const link = cx(base, 'hidden sm:block');
  return (
    <header className={cx('top-0 z-40', night ? 'absolute inset-x-0 text-night-text' : 'sticky border-b border-border/70 bg-bg/80 backdrop-blur-md')}>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" aria-label="Wren home" className="rounded-lg">
          <Logo tone={night ? 'night' : 'auto'} />
        </Link>
        <nav className="flex items-center gap-1 text-sm" aria-label="Site">
          <Link href="/#day" className={link}>
            How it works
          </Link>
          <Link href="/#plans" className={cx(base, 'hidden md:block')}>
            Your AI plans
          </Link>
          <Link href="/download" className={base}>
            Download
          </Link>
          <a href="/login" className={link}>
            Sign in
          </a>
          <a href="/signup" className={cx('ml-1 rounded-[10px] px-4 py-2 font-semibold transition-[background-color,transform] active:scale-[0.97]', night ? 'bg-night-text text-night hover:bg-white' : 'bg-primary text-primary-fg hover:opacity-90')}>
            Get started
          </a>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 text-sm sm:grid-cols-[1fr_auto] sm:items-end sm:px-6">
        <div>
          <Logo />
          <p className="mt-3 max-w-xs text-muted">Personal AI agents with their own computers. Open source, MIT licensed.</p>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2 text-muted" aria-label="Footer">
          <Link href="/download" className="hover:text-text">
            Download
          </Link>
          <Link href="/legal" className="hover:text-text">
            Terms and privacy
          </Link>
          <a href="https://github.com/tamoghnakabi-wq/wren" className="hover:text-text" target="_blank" rel="noreferrer">
            Source code
          </a>
          <a href="/login" className="hover:text-text">
            Sign in
          </a>
        </nav>
      </div>
    </footer>
  );
}
