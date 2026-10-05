'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, CalendarClock, FolderOpen, Gauge, Home, Inbox, LayoutGrid, LogOut, Menu, Monitor, PanelLeftClose, PanelLeftOpen, Plug, Plus, Settings, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Logo, WrenMark } from '../brand';
import { AgentAvatar } from '../agent-avatar';
import { cx } from '../ui';
import { useApp } from './provider';
import { supabase } from '@/lib/client/supabase';
import { isLiveDevice } from '@/lib/client/types';
import { paneShortcut, togglePane, usePaneCollapsed } from '@/lib/client/layout';
import { PushPrompt } from './push';
import { DesktopLinkBanner } from './desktop-link';
import { ChatGPTWelcome } from './chatgpt-ui';

const NAV = [
  { href: '/app', label: 'Home', icon: Home, exact: true },
  { href: '/app/inbox', label: 'Inbox', icon: Inbox, badge: 'inbox' as const },
  { href: '/app/agents', label: 'Agents', icon: LayoutGrid },
  { href: '/app/files', label: 'Files', icon: FolderOpen },
  { href: '/app/schedules', label: 'Schedules', icon: CalendarClock },
  { href: '/app/connections', label: 'Connections', icon: Plug },
  { href: '/app/usage', label: 'Usage', icon: Gauge },
  { href: '/app/settings', label: 'Settings', icon: Settings },
];

function useInboxCount() {
  const { approvals, unread } = useApp();
  return approvals.length + unread;
}

/** Count badge text: very large numbers read as 99+. */
const badge = (n: number) => (n > 99 ? '99+' : String(n));

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const [drawerFor, setDrawerFor] = useState(pathname);
  // Navigating closes the menu (adjusted during render rather than in an effect).
  if (drawerFor !== pathname) {
    setDrawerFor(pathname);
    setDrawer(false);
  }
  const fullBleed = pathname.startsWith('/app/s/');
  const closeDrawer = useCallback(() => setDrawer(false), []);

  // ⌘\ / Ctrl+\ collapses the sidebar; ⇧ also: the task details.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const pane = paneShortcut(e);
      if (!pane) return;
      e.preventDefault();
      togglePane(pane);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only z-[70] rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>
      <aside className="wren-sidebar sticky top-0 z-20 hidden h-dvh w-[264px] shrink-0 flex-col border-r border-border bg-bg-subtle/60 transition-[width] duration-200 ease-out motion-reduce:transition-none lg:flex rail:w-[68px]">
        <SidebarContent collapsible />
      </aside>

      {drawer && <Drawer onClose={closeDrawer} />}

      <div className="flex min-w-0 flex-1 flex-col">
        {!fullBleed && <MobileTopBar onMenu={() => setDrawer(true)} />}
        <main id="main" tabIndex={-1} className={cx('flex-1 focus:outline-none', fullBleed ? '' : 'px-4 pt-4 pb-28 sm:px-6 lg:px-10 lg:pt-10 lg:pb-12')}>
          <div className={cx(fullBleed ? '' : 'mx-auto w-full max-w-5xl')}>
            {!fullBleed && <DesktopLinkBanner />}
            {children}
          </div>
        </main>
        {!fullBleed && <MobileTabBar />}
      </div>
      <PushPrompt />
      <ChatGPTWelcome />
    </div>
  );
}

/** The phone menu: a modal panel that slides in, closes on Escape or a tap outside, and returns focus. */
function Drawer({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab' || !panel.current) return;
      // Keep Tab inside the menu while it is open.
      const f = Array.from(panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) {
        e.preventDefault();
        f[f.length - 1].focus();
      } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
        e.preventDefault();
        f[0].focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
      <div className="fade-in absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <aside ref={panel} className="drawer-in absolute inset-y-0 left-0 flex w-[84%] max-w-[300px] flex-col bg-bg shadow-pop" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <button className="absolute top-4 right-3 z-10 rounded-lg p-1.5 text-muted transition-colors hover:bg-bg-subtle hover:text-text" style={{ marginTop: 'env(safe-area-inset-top)' }} onClick={onClose} aria-label="Close menu">
          <X className="h-5 w-5" />
        </button>
        <SidebarContent />
      </aside>
    </div>
  );
}

/** Label shown beside a rail icon on hover or keyboard focus (only while the sidebar is a rail). */
function RailTip({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="pointer-events-none absolute top-1/2 left-full z-50 ml-3 hidden -translate-y-1/2 rounded-md bg-primary px-2 py-1 text-[12px] font-medium whitespace-nowrap text-primary-fg opacity-0 shadow-pop transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 rail:block">
      {children}
    </span>
  );
}

function noSubscribe() {
  return () => {};
}
/** For shortcut hints: ⌘ on a Mac, Ctrl elsewhere (decided after hydration). */
export function useIsMac() {
  return useSyncExternalStore(noSubscribe, () => /Mac|iPhone|iPad/.test(navigator.platform), () => true);
}

/** Collapses the desktop sidebar to an icon rail, or expands it again. */
function SidebarToggle() {
  const collapsed = usePaneCollapsed('sidebar');
  const mac = useIsMac();
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return (
    <button
      type="button"
      onClick={() => togglePane('sidebar')}
      aria-label={label}
      aria-expanded={!collapsed}
      title={`${label} (${mac ? '⌘' : 'Ctrl+'}\\)`}
      className="group relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-faint transition-colors hover:bg-surface hover:text-text"
    >
      <PanelLeftClose className="h-4 w-4 rail:hidden" aria-hidden />
      <PanelLeftOpen className="hidden h-4 w-4 rail:block" aria-hidden />
    </button>
  );
}

function SidebarContent({ collapsible = false }: { collapsible?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const { agents, active, devices, email, profile } = useApp();
  const inbox = useInboxCount();
  const liveAgents = new Map(active.map((s) => [s.agent_id, s.status === 'waiting' ? ('waiting' as const) : ('running' as const)]));
  const online = devices.filter(isLiveDevice);
  const deviceLabel = online.length ? online.map((d) => d.name).join(', ') : `${devices.length} computer${devices.length > 1 ? 's' : ''} offline`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-4 rail:flex-col rail:px-0 rail:pb-3">
        <Link href="/app" aria-label="Wren home" className="rounded-lg">
          <Logo className="rail:hidden" />
          <WrenMark className="hidden rail:block" />
        </Link>
        {collapsible && <SidebarToggle />}
      </div>
      <div className="px-3 rail:px-0">
        <Link href="/app?compose=1" aria-label="New task" className="group relative flex h-10 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-medium text-primary-fg shadow-sm transition hover:opacity-90 rail:mx-auto rail:w-10">
          <Plus className="h-4 w-4 shrink-0" aria-hidden /> <span className="rail:sr-only">New task</span>
          <RailTip>New task</RailTip>
        </Link>
      </div>
      <nav className="mt-4 space-y-0.5 px-3 rail:px-2.5" aria-label="Main">
        {NAV.map((n) => {
          const on = n.exact ? pathname === n.href : pathname.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-current={on ? 'page' : undefined}
              className={cx('group relative flex h-9 items-center gap-3 rounded-lg px-3 text-sm transition-colors rail:justify-center rail:px-0', on ? 'bg-surface font-medium text-text shadow-sm' : 'text-muted hover:bg-surface/70 hover:text-text')}
            >
              <n.icon className="h-4 w-4 shrink-0" aria-hidden />
              <span className="flex-1 rail:sr-only">{n.label}</span>
              {n.badge && inbox > 0 && (
                <span className="rounded-full bg-brand-solid px-1.5 text-[11px] font-semibold text-brand-fg tabular-nums rail:absolute rail:top-0.5 rail:right-1 rail:px-1 rail:text-[9.5px] rail:leading-[14px]" aria-label={`${inbox} new`}>
                  {badge(inbox)}
                </span>
              )}
              <RailTip>{n.label}</RailTip>
            </Link>
          );
        })}
      </nav>
      <div className="mt-6 flex items-center justify-between px-6 text-[11px] font-semibold tracking-wider text-faint uppercase rail:mt-4 rail:justify-center rail:border-t rail:border-border rail:px-0 rail:pt-4">
        <span className="rail:sr-only">Agents</span>
        <Link href="/app/agents/new" className="group relative rounded p-0.5 transition-colors hover:bg-surface hover:text-text rail:p-1.5" aria-label="New agent">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          <RailTip>New agent</RailTip>
        </Link>
      </div>
      <div className="mt-1.5 flex-1 space-y-0.5 overflow-y-auto px-3 scrollbar-thin rail:px-2.5">
        {agents.map((a) => (
          <Link
            key={a.id}
            href={`/app/agents/${a.id}`}
            aria-current={pathname === `/app/agents/${a.id}` ? 'page' : undefined}
            title={collapsible ? a.name : undefined}
            className={cx('flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors rail:justify-center rail:px-0', pathname === `/app/agents/${a.id}` ? 'bg-surface font-medium shadow-sm' : 'text-muted hover:bg-surface/70 hover:text-text')}
          >
            <AgentAvatar icon={a.icon} color={a.color} size={24} live={liveAgents.get(a.id) ?? null} seed={a.id} />
            <span className="truncate rail:sr-only">{a.name}</span>
          </Link>
        ))}
        {!agents.length && <p className="px-3 py-1 text-[13px] text-faint rail:sr-only">No agents yet.</p>}
      </div>
      <div className="border-t border-border p-3 rail:px-2.5">
        {devices.length > 0 && (
          <Link href="/app/connections#devices" title={collapsible ? deviceLabel : undefined} className="mb-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-surface/70 rail:relative rail:justify-center rail:px-0">
            <Monitor className="h-4 w-4 shrink-0" aria-hidden />
            <span className="flex-1 truncate rail:sr-only">{deviceLabel}</span>
            <span className={cx('h-2 w-2 shrink-0 rounded-full rail:absolute rail:top-1 rail:right-3', online.length ? 'bg-success' : 'bg-border-strong')} aria-hidden />
          </Link>
        )}
        <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 rail:flex-col rail:px-0">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface text-xs font-semibold shadow-sm" title={collapsible ? email : undefined}>
            {(profile?.display_name ?? email ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted rail:sr-only">{email}</span>
          <button
            onClick={async () => {
              await supabase().auth.signOut();
              router.replace('/login');
              router.refresh();
            }}
            className="rounded-md p-1 text-faint transition-colors hover:bg-surface hover:text-text"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}

function MobileTopBar({ onMenu }: { onMenu: () => void }) {
  const inbox = useInboxCount();
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-bg/85 px-3 backdrop-blur-md lg:hidden" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <button onClick={onMenu} className="rounded-lg p-2 text-muted transition-colors hover:text-text" aria-label="Open menu">
        <Menu className="h-5 w-5" />
      </button>
      <Link href="/app" aria-label="Wren home">
        <Logo />
      </Link>
      <Link href="/app/inbox" className="relative rounded-lg p-2 text-muted transition-colors hover:text-text" aria-label={inbox ? `Inbox, ${inbox} new` : 'Inbox'}>
        <Bell className="h-5 w-5" aria-hidden />
        {inbox > 0 && (
          <span aria-hidden className="absolute top-1 right-1 min-w-4 rounded-full bg-brand-solid px-1 text-center text-[10px] leading-4 font-bold text-brand-fg tabular-nums">
            {badge(inbox)}
          </span>
        )}
      </Link>
    </header>
  );
}

function MobileTabBar() {
  const pathname = usePathname();
  const inbox = useInboxCount();
  const tabs = [
    { href: '/app', icon: Home, label: 'Home', exact: true },
    { href: '/app/agents', icon: LayoutGrid, label: 'Agents' },
    { href: '/app?compose=1', icon: Plus, label: 'New', primary: true },
    { href: '/app/inbox', icon: Inbox, label: 'Inbox', badge: inbox },
    { href: '/app/settings', icon: Settings, label: 'Settings' },
  ];
  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg/90 backdrop-blur-md lg:hidden">
      <div className="mx-auto flex h-16 max-w-md items-center justify-around px-2">
        {tabs.map((t) => {
          const on = t.exact ? pathname === t.href : pathname.startsWith(t.href.split('?')[0]) && !t.primary;
          if (t.primary)
            return (
              <Link key={t.label} href={t.href} className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary text-primary-fg shadow-pop transition-transform active:scale-95" aria-label="New task">
                <t.icon className="h-5 w-5" aria-hidden />
              </Link>
            );
          return (
            <Link
              key={t.label}
              href={t.href}
              aria-current={on ? 'page' : undefined}
              aria-label={t.badge ? `${t.label}, ${t.badge} new` : undefined}
              className={cx('relative flex w-14 flex-col items-center gap-0.5 py-1 text-[10.5px] font-medium transition-colors', on ? 'text-text' : 'text-faint hover:text-muted')}
            >
              <t.icon className="h-5 w-5" aria-hidden />
              {t.label}
              {on && <span aria-hidden className="absolute -bottom-1.5 h-1 w-1 rounded-full bg-text" />}
              {!!t.badge && (
                <span aria-hidden className="absolute -top-1 right-2 min-w-4 rounded-full bg-brand-solid px-1 text-center text-[10px] leading-4 font-bold text-brand-fg tabular-nums">
                  {badge(t.badge)}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
