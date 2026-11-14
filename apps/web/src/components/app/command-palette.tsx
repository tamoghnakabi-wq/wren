'use client';

import { useRouter } from 'next/navigation';
import { CalendarClock, CornerDownLeft, FolderOpen, Gauge, Home, Inbox, LayoutGrid, ListChecks, MessageSquare, Plug, Plus, Search, Settings, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgentAvatar } from '../agent-avatar';
import { cx, Spinner, timeAgo } from '../ui';
import { useApp } from './provider';
import { StatusPill } from './status';
import { api } from '@/lib/client/api';
import { supabase } from '@/lib/client/supabase';
import type { Session, SessionStatus } from '@/lib/client/types';
import { markWords, searchWords, type SearchResult } from '@/lib/search';

// ⌘K / Ctrl+K anywhere in the app, the sidebar's Search, or the phone's search button: jump to a page or an
// agent, or find a task by its title or by anything said in it.

const OPEN_EVENT = 'wren:palette';

/** Opens the palette (from a button; the shortcut is handled by the shell). */
export function openPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** ⌘K on a Mac, Ctrl+K elsewhere; not while composing text with an input method. */
export function paletteShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && !e.isComposing && e.key.toLowerCase() === 'k';
}

/** Whether the palette was asked for (the shell renders it). */
export function usePaletteRequests(onOpen: () => void) {
  const cb = useRef(onOpen);
  useEffect(() => {
    cb.current = onOpen;
  });
  useEffect(() => {
    const open = () => cb.current();
    const onKey = (e: KeyboardEvent) => {
      if (!paletteShortcut(e)) return;
      e.preventDefault();
      open();
    };
    window.addEventListener(OPEN_EVENT, open);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, open);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
}

const PAGES: { href: string; label: string; icon: LucideIcon; words?: string }[] = [
  { href: '/app?compose=1', label: 'New task', icon: Plus, words: 'start create' },
  { href: '/app', label: 'Home', icon: Home },
  { href: '/app/tasks', label: 'All tasks', icon: ListChecks, words: 'archived history' },
  { href: '/app/inbox', label: 'Inbox', icon: Inbox, words: 'approvals notifications' },
  { href: '/app/agents', label: 'Agents', icon: LayoutGrid },
  { href: '/app/files', label: 'Files', icon: FolderOpen, words: 'uploads' },
  { href: '/app/schedules', label: 'Schedules', icon: CalendarClock, words: 'cron recurring' },
  { href: '/app/connections', label: 'Connections', icon: Plug, words: 'models keys github computers devices mcp' },
  { href: '/app/usage', label: 'Usage', icon: Gauge, words: 'tokens' },
  { href: '/app/settings', label: 'Settings', icon: Settings, words: 'profile security notifications' },
];

interface Item {
  key: string;
  href: string;
  group: string;
  title: ReactNode;
  detail?: ReactNode;
  lead: ReactNode;
  trail?: ReactNode;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-label="Search Wren"
      className="dialog-in mx-auto mt-[min(12dvh,120px)] mb-auto w-[calc(100%-24px)] max-w-xl rounded-2xl border border-border bg-surface p-0 text-text shadow-pop backdrop:bg-black/40 backdrop:backdrop-blur-[2px]"
    >
      {open && <Palette onClose={onClose} />}
    </dialog>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { agents, agentById, userId } = useApp();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ q: string; result: SearchResult } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [recent, setRecent] = useState<Session[]>([]);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const query = q.trim();
  const words = useMemo(() => searchWords(query), [query]);

  // Recent tasks for an empty query.
  useEffect(() => {
    let live = true;
    supabase()
      .from('sessions')
      .select('id, agent_id, title, status, last_event_at, archived_at')
      .eq('user_id', userId)
      .is('archived_at', null)
      .order('last_event_at', { ascending: false })
      .limit(6)
      .then(({ data }) => live && setRecent((data ?? []) as Session[]));
    return () => {
      live = false;
    };
  }, [userId]);

  // The server's search, a moment after typing stops; an older answer never replaces a newer one.
  useEffect(() => {
    if (!words.length) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const result = await api<SearchResult>('/api/search', { body: { q: query }, signal: ctl.signal });
        setFound({ q: query, result });
        setFailed(null);
      } catch (e) {
        if (!ctl.signal.aborted) setFailed((e as Error).message);
      }
    }, 180);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query, words.length]);

  const searching = words.length > 0 && found?.q !== query && !failed;
  const result = words.length && found?.q === query ? found.result : null;

  const items = useMemo((): Item[] => {
    const out: Item[] = [];
    const matches = (label: string, extra = '') => {
      const hay = `${label} ${extra}`.toLowerCase();
      return words.every((w) => hay.split(/[^\p{L}\p{N}]+/u).some((h) => h.startsWith(w)));
    };
    const taskLead = (agentId: string) => {
      const a = agentById(agentId);
      return <AgentAvatar icon={a?.icon} color={a?.color} size={24} seed={agentId} />;
    };
    const status = (s: string, archived: boolean) =>
      archived ? <span className="text-[12px] text-faint">Archived</span> : <StatusPill status={s as SessionStatus} className="hidden sm:inline-flex" />;
    if (!query) {
      for (const s of recent)
        out.push({ key: `r${s.id}`, href: `/app/s/${s.id}`, group: 'Recent tasks', title: s.title, detail: `${agentById(s.agent_id)?.name ?? 'Removed agent'}, ${timeAgo(s.last_event_at)}`, lead: taskLead(s.agent_id), trail: status(s.status, false) });
    }
    const pages = PAGES.filter((p) => !query || matches(p.label, p.words));
    const people = query ? agents.filter((a) => matches(a.name)) : [];
    for (const p of pages.slice(0, query ? 5 : PAGES.length)) out.push({ key: p.href, href: p.href, group: 'Go to', title: <Marked text={p.label} words={words} />, lead: <Icon icon={p.icon} /> });
    for (const a of people.slice(0, 5)) {
      out.push({ key: `a${a.id}`, href: `/app/agents/${a.id}`, group: 'Agents', title: <Marked text={a.name} words={words} />, lead: <AgentAvatar icon={a.icon} color={a.color} size={24} seed={a.id} /> });
      out.push({ key: `n${a.id}`, href: `/app?compose=1&agent=${a.id}`, group: 'Agents', title: `New task with ${a.name}`, lead: <Icon icon={Plus} /> });
    }
    for (const t of result?.tasks ?? [])
      out.push({ key: `t${t.id}`, href: `/app/s/${t.id}`, group: 'Tasks', title: <Marked text={t.title} words={words} />, detail: `${agentById(t.agentId)?.name ?? 'Removed agent'}, ${timeAgo(t.at)}`, lead: taskLead(t.agentId), trail: status(t.status, t.archived) });
    for (const m of result?.messages ?? [])
      out.push({
        key: `m${m.id}`,
        href: `/app/s/${m.id}?at=${m.seq}`,
        group: 'In messages',
        title: m.title,
        detail: (
          <>
            <span className="text-faint">{m.role === 'user' ? 'You: ' : `${agentById(m.agentId)?.name ?? 'Agent'}: `}</span>
            <Marked text={m.snippet} words={words} />
          </>
        ),
        lead: <Icon icon={MessageSquare} />,
        trail: <span className="text-[12px] whitespace-nowrap text-faint">{timeAgo(m.at)}</span>,
      });
    return out;
  }, [query, words, recent, agents, agentById, result]);

  // The highlighted row stays in range and in view.
  const current = Math.min(active, Math.max(items.length - 1, 0));
  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const go = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    router.push(item.href);
  };

  const groups: { name: string; items: (Item & { index: number })[] }[] = [];
  items.forEach((it, index) => {
    const g = groups.find((x) => x.name === it.group);
    if (g) g.items.push({ ...it, index });
    else groups.push({ name: it.group, items: [{ ...it, index }] });
  });
  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <div className="flex max-h-[min(70dvh,560px)] flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4">
        {searching ? <Spinner className="h-4 w-4 shrink-0 text-faint" label="Searching" /> : <Search className="h-4 w-4 shrink-0 text-faint" aria-hidden />}
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (!items.length) return;
              setActive((current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
            } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              go(items[current]);
            }
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={items.length ? optionId(current) : undefined}
          aria-autocomplete="list"
          aria-label="Search tasks, agents and pages"
          placeholder="Search tasks, agents and pages"
          enterKeyHint="go"
          autoComplete="off"
          spellCheck={false}
          className="h-14 min-w-0 flex-1 bg-transparent text-[16px] text-text outline-none placeholder:text-faint"
        />
        <kbd className="hidden rounded-md border border-border px-1.5 py-0.5 font-sans text-[11px] text-faint sm:block">Esc</kbd>
      </div>
      <div ref={list} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
        {groups.map((g) => (
          <div key={g.name} role="group" aria-label={g.name} className="mb-1 last:mb-0">
            <div className="px-3 pt-2 pb-1 text-[12px] font-medium text-faint">{g.name}</div>
            {g.items.map((it) => (
              <div
                key={it.key}
                id={optionId(it.index)}
                data-index={it.index}
                role="option"
                aria-selected={it.index === current}
                onMouseMove={() => it.index !== current && setActive(it.index)}
                onClick={() => go(it)}
                className={cx('flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2', it.index === current && 'bg-bg-subtle')}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center">{it.lead}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-text">{it.title}</span>
                  {it.detail && <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-snug text-muted">{it.detail}</span>}
                </span>
                {it.trail}
                {it.index === current && <CornerDownLeft className="hidden h-3.5 w-3.5 shrink-0 text-faint sm:block" aria-hidden />}
              </div>
            ))}
          </div>
        ))}
        {!items.length && !searching && (
          <p className="px-3 py-8 text-center text-[14px] text-muted">{failed ? `Search failed: ${failed}` : `Nothing matches “${query}”.`}</p>
        )}
        {query && !!items.length && !searching && result && !result.tasks.length && !result.messages.length && (
          <p className="px-3 pt-2 pb-3 text-[12.5px] text-faint">No task has those words.</p>
        )}
      </div>
    </div>
  );
}

function Icon({ icon: I }: { icon: LucideIcon }) {
  return (
    <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-bg text-muted">
      <I className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}

function Marked({ text, words }: { text: string; words: string[] }) {
  return (
    <>
      {markWords(text, words).map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-[3px] bg-transparent font-semibold text-text underline decoration-border-strong underline-offset-2">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}
