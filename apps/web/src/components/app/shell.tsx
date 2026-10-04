'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, CalendarClock, FolderOpen, Gauge, Home, Inbox, LayoutGrid, LogOut, Menu, Monitor, Plug, Plus, Settings, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Logo } from '../brand';
import { AgentAvatar } from '../agent-avatar';
import { cx } from '../ui';
import { useApp } from './provider';
import { supabase } from '@/lib/client/supabase';
import { isLiveDevice } from '@/lib/client/types';
import { PushPrompt } from './push';

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

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [pathname]);
  const fullBleed = pathname.startsWith('/app/s/');

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-[264px] shrink-0 flex-col border-r border-border bg-bg-subtle/60 lg:flex">
        <SidebarContent />
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
          <aside className="animate-in absolute inset-y-0 left-0 flex w-[84%] max-w-[300px] flex-col bg-bg shadow-pop">
            <button className="absolute top-4 right-3 rounded-lg p-1.5 text-muted" onClick={() => setDrawer(false)} aria-label="Close menu">
              <X className="h-5 w-5" />
            </button>
            <SidebarContent />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {!fullBleed && <MobileTopBar onMenu={() => setDrawer(true)} />}
        <main className={cx('flex-1', fullBleed ? '' : 'px-4 pt-4 pb-28 sm:px-6 lg:px-10 lg:pt-10 lg:pb-12')}>
          <div className={cx(fullBleed ? '' : 'mx-auto w-full max-w-5xl')}>{children}</div>
        </main>
        {!fullBleed && <MobileTabBar />}
      </div>
      <PushPrompt />
    </div>
  );
}

function SidebarContent() {
  const pathname = usePathname();
  const router = useRouter();
  const { agents, active, devices, email, profile } = useApp();
  const inbox = useInboxCount();
  const liveAgents = new Map(active.map((s) => [s.agent_id, s.status === 'waiting' ? ('waiting' as const) : ('running' as const)]));
  const online = devices.filter(isLiveDevice);

  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pt-5 pb-4">
        <Link href="/app" aria-label="Wren home">
          <Logo />
        </Link>
      </div>
      <div className="px-3">
        <Link href="/app?compose=1" className="flex h-10 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-medium text-primary-fg shadow-sm transition hover:opacity-90">
          <Plus className="h-4 w-4" /> New task
        </Link>
      </div>
      <nav className="mt-4 space-y-0.5 px-3">
        {NAV.map((n) => {
          const on = n.exact ? pathname === n.href : pathname.startsWith(n.href);
          return (
            <Link key={n.href} href={n.href} className={cx('flex h-9 items-center gap-3 rounded-lg px-3 text-sm transition', on ? 'bg-surface font-medium text-text shadow-sm' : 'text-muted hover:bg-surface/70 hover:text-text')}>
              <n.icon className="h-4 w-4" />
              <span className="flex-1">{n.label}</span>
              {n.badge && inbox > 0 && <span className="rounded-full bg-brand px-1.5 text-[11px] font-semibold text-white">{inbox}</span>}
            </Link>
          );
        })}
      </nav>
      <div className="mt-6 flex items-center justify-between px-6 text-[11px] font-semibold tracking-wider text-faint uppercase">
        Agents
        <Link href="/app/agents/new" className="rounded p-0.5 hover:bg-surface hover:text-text" aria-label="New agent">
          <Plus className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="mt-1.5 flex-1 space-y-0.5 overflow-y-auto px-3 scrollbar-thin">
        {agents.map((a) => (
          <Link key={a.id} href={`/app/agents/${a.id}`} className={cx('flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition', pathname === `/app/agents/${a.id}` ? 'bg-surface shadow-sm' : 'hover:bg-surface/70')}>
            <AgentAvatar icon={a.icon} color={a.color} size={24} live={liveAgents.get(a.id) ?? null} />
            <span className="truncate">{a.name}</span>
          </Link>
        ))}
        {!agents.length && <p className="px-3 py-1 text-[13px] text-faint">No agents yet.</p>}
      </div>
      <div className="border-t border-border p-3">
        {devices.length > 0 && (
          <Link href="/app/connections#devices" className="mb-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] text-muted hover:bg-surface/70">
            <Monitor className="h-4 w-4" />
            <span className="flex-1 truncate">{online.length ? online.map((d) => d.name).join(', ') : `${devices.length} computer${devices.length > 1 ? 's' : ''} offline`}</span>
            <span className={cx('h-2 w-2 rounded-full', online.length ? 'bg-success' : 'bg-border-strong')} />
          </Link>
        )}
        <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface text-xs font-semibold shadow-sm">{(profile?.display_name ?? email ?? '?').slice(0, 1).toUpperCase()}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{email}</span>
          <button
            onClick={async () => {
              await supabase().auth.signOut();
              router.replace('/login');
              router.refresh();
            }}
            className="rounded-md p-1 text-faint hover:bg-surface hover:text-text"
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut className="h-4 w-4" />
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
      <button onClick={onMenu} className="rounded-lg p-2 text-muted" aria-label="Open menu">
        <Menu className="h-5 w-5" />
      </button>
      <Link href="/app" aria-label="Wren home">
        <Logo />
      </Link>
      <Link href="/app/inbox" className="relative rounded-lg p-2 text-muted" aria-label="Inbox">
        <Bell className="h-5 w-5" />
        {inbox > 0 && <span className="absolute top-1 right-1 min-w-4 rounded-full bg-brand px-1 text-center text-[10px] leading-4 font-bold text-white">{inbox}</span>}
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
              <Link key={t.label} href={t.href} className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary text-primary-fg shadow-pop" aria-label="New task">
                <t.icon className="h-5 w-5" />
              </Link>
            );
          return (
            <Link key={t.label} href={t.href} className={cx('relative flex w-14 flex-col items-center gap-0.5 text-[10.5px] font-medium', on ? 'text-text' : 'text-faint')}>
              <t.icon className="h-5 w-5" />
              {t.label}
              {!!t.badge && <span className="absolute -top-1 right-2 min-w-4 rounded-full bg-brand px-1 text-center text-[10px] leading-4 font-bold text-white">{t.badge}</span>}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
