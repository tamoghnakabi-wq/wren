import Link from 'next/link';
import { Logo } from './brand';

export function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-transparent bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" aria-label="Wren home">
          <Logo />
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          <Link href="/#how" className="hidden rounded-lg px-3 py-2 text-muted hover:text-text sm:block">
            How it works
          </Link>
          <Link href="/#plans" className="hidden rounded-lg px-3 py-2 text-muted hover:text-text md:block">
            Your AI plans
          </Link>
          <Link href="/download" className="rounded-lg px-3 py-2 text-muted hover:text-text">
            Download
          </Link>
          <a href="/login" className="hidden rounded-lg px-3 py-2 text-muted hover:text-text sm:block">
            Sign in
          </a>
          <a href="/signup" className="ml-1 rounded-xl bg-primary px-4 py-2 font-medium text-primary-fg hover:opacity-90">
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
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-center gap-3">
          <Logo />
          <span className="text-faint">Agents that get things done.</span>
        </div>
        <div className="flex flex-wrap gap-5">
          <Link href="/download" className="hover:text-text">
            Download
          </Link>
          <Link href="/legal" className="hover:text-text">
            Terms & privacy
          </Link>
          <a href="https://github.com/tamoghnakabi-wq/wren" className="hover:text-text" target="_blank" rel="noreferrer">
            Source (MIT)
          </a>
          <a href="/login" className="hover:text-text">
            Sign in
          </a>
        </div>
      </div>
    </footer>
  );
}
