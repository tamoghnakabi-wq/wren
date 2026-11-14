'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Archive, Clock, Cloud, Download, FileText, Laptop, LayoutTemplate, Maximize2, MoreHorizontal, PanelRightClose, PanelRightOpen, Pause, Play, Square, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { AgentAvatar } from '@/components/agent-avatar';
import type { Mood } from '@/lib/characters';
import { Composer } from '@/components/app/composer';
import { useApp } from '@/components/app/provider';
import { StatusPill } from '@/components/app/status';
import { useIsMac } from '@/components/app/shell';
import { togglePane, usePaneCollapsed } from '@/lib/client/layout';
import { PlanCard, Timeline, whenLabel } from '@/components/app/timeline';
import { AgentCharacter } from '@/components/agent-character';
import { Button, ButtonLink, cx, EmptyState, formatBytes, formatTokens, Menu, Skeleton, timeAgo, useConfirm, useToast } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useLive } from '@/lib/client/live';
import { supabase } from '@/lib/client/supabase';
import { modelLabel } from '@/lib/client/sources';
import { isLiveDevice, type Artifact, type EventRow, type PlanItem, type Run, type RunLive, type Session } from '@/lib/client/types';

/** Events per page of task history. */
const PAGE = 500;

// The address's query, read as an outside store (search opens a task at one message with `?at=<seq>`).
const subscribeUrl = (cb: () => void) => {
  window.addEventListener('popstate', cb);
  return () => window.removeEventListener('popstate', cb);
};
const urlSearch = () => window.location.search;

/** Scrolls an event of the task into view and marks it for a moment; false when it isn't shown. */
function revealEvent(container: HTMLElement | null, seq: number): boolean {
  const el = container?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('search-hit');
  setTimeout(() => el.classList.remove('search-hit'), 2400);
  return true;
}

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { agentById, approvals, devices } = useApp();
  const session = useLive<Session>({ table: 'sessions', eq: { id }, realtimeFilter: { column: 'id', value: id } });
  // The newest events stay live; older history loads a page at a time on request (by seq).
  // keepAll: rows that scroll out of the newest page stay, so the timeline has no holes between
  // the live part and the older pages loaded below.
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const eventsLive = useLive<EventRow>({ table: 'events', eq: { session_id: id }, order: { column: 'seq', ascending: false }, limit: PAGE, keepAll: true, realtimeFilter: { column: 'session_id', value: id } });
  const [older, setOlder] = useState<{ session: string; rows: EventRow[]; more: boolean }>({ session: id, rows: [], more: true });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderRows = useMemo(() => (older.session === id ? older.rows : []), [older, id]);
  const events = useMemo(() => {
    const byId = new Map<string, EventRow>();
    for (const e of olderRows) byId.set(e.id, e);
    for (const e of eventsLive.rows) byId.set(e.id, e);
    return { ...eventsLive, rows: [...byId.values()].sort((a, b) => a.seq - b.seq) };
  }, [eventsLive, olderRows]);
  const hasOlder = !eventsLive.loading && eventsLive.rows.length >= PAGE && (older.session !== id || older.more);
  // The current plan is fetched on its own, so it shows even when it is older than the loaded history.
  const latestPlan = useLive<EventRow>({ table: 'events', eq: { session_id: id, type: 'plan' }, order: { column: 'seq', ascending: false }, limit: 1, realtimeFilter: { column: 'session_id', value: id } });
  const loadOlder = async () => {
    const first = events.rows[0];
    if (!first || loadingOlder) return;
    setLoadingOlder(true);
    const { data, error } = await supabase().from('events').select('*').eq('session_id', id).lt('seq', first.seq).order('seq', { ascending: false }).limit(PAGE);
    setLoadingOlder(false);
    if (error) return toast(error.message, 'error');
    const rows = (data ?? []) as EventRow[];
    // Earlier history goes above: keep what the user was looking at in place.
    const el = scroller.current;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    flushSync(() => setOlder((o) => ({ session: id, rows: [...rows, ...(o.session === id ? o.rows : [])], more: rows.length === PAGE })));
    if (el) el.scrollTop = el.scrollHeight - fromBottom;
  };
  // Opened from search at one message (`?at=<seq>`): history back to it is loaded, then it's scrolled to.
  const search = useSyncExternalStore(subscribeUrl, urlSearch, () => '');
  const atParam = Number(new URLSearchParams(search).get('at'));
  const jumpTo = Number.isSafeInteger(atParam) && atParam > 0 ? atParam : null;
  const jumpKey = jumpTo ? `${id}:${jumpTo}` : '';
  const [jumpLoad, setJumpLoad] = useState<{ key: string; stage: 'loading' | 'loaded' | 'done' } | null>(null);
  const jumpStage = jumpLoad?.key === jumpKey ? jumpLoad.stage : 'look';
  useEffect(() => {
    if (!jumpTo || jumpStage === 'loading' || jumpStage === 'done' || eventsLive.loading) return;
    const first = events.rows[0];
    const shown = revealEvent(scroller.current, jumpTo);
    if (shown || jumpStage === 'loaded' || !first || first.seq <= jumpTo) {
      // Found, or not in this task's history (deleted, or not a message shown): the task as it is.
      if (shown) stick.current = false;
      window.history.replaceState(window.history.state, '', window.location.pathname);
      setJumpLoad({ key: jumpKey, stage: 'done' });
      return;
    }
    setJumpLoad({ key: jumpKey, stage: 'loading' });
    // Everything from just before that message up to the history already shown, a page at a time (the
    // database answers at most 1000 rows per request), so the timeline has no hole in between.
    void (async () => {
      const rows: EventRow[] = [];
      let below = first.seq;
      for (let page = 0; page < 6; page++) {
        const { data, error } = await supabase().from('events').select('*').eq('session_id', id).gte('seq', jumpTo - 20).lt('seq', below).order('seq', { ascending: false }).limit(1000);
        if (error) {
          toast(error.message, 'error');
          break;
        }
        rows.push(...((data ?? []) as EventRow[]));
        if (!data || data.length < 1000) break;
        below = (data[data.length - 1] as EventRow).seq;
      }
      rows.reverse();
      setOlder((o) => ({ session: id, rows: [...rows, ...(o.session === id ? o.rows : [])], more: true }));
      setJumpLoad((j) => (j?.key === jumpKey ? { key: jumpKey, stage: 'loaded' } : j));
    })();
  }, [jumpTo, jumpKey, jumpStage, id, eventsLive.loading, events.rows, toast]);
  const runs = useLive<Run>({ table: 'runs', eq: { session_id: id }, order: { column: 'created_at' }, limit: 20, realtimeFilter: { column: 'session_id', value: id } });
  const live = useLive<RunLive>({ table: 'run_live', eq: { session_id: id }, pk: 'run_id', realtimeFilter: { column: 'session_id', value: id } });
  const files = useLive<Artifact>({ table: 'artifacts', eq: { session_id: id }, order: { column: 'created_at' }, realtimeFilter: { column: 'session_id', value: id } });
  const [panel, setPanel] = useState<'activity' | 'screen' | 'files'>('activity');
  const confirm = useConfirm();

  const s = session.rows[0];
  const agent = agentById(s?.agent_id);
  const run = runs.rows[0];
  // runs.step is only saved when a run stops, so count model turns while it works.
  const turns = new Map<string, number>();
  for (const e of events.rows) if (e.run_id && e.type === 'message' && e.data.role === 'assistant') turns.set(e.run_id, (turns.get(e.run_id) ?? 0) + 1);
  const steps = runs.rows.reduce((n, r) => n + Math.max(r.step, turns.get(r.id) ?? 0), 0);
  const sessionApprovals = approvals.filter((a) => a.session_id === id);
  // Waiting for another agent's answer counts as working: the task is busy, through that agent.
  const askingAgent = events.rows.some((e) => e.type === 'tool' && e.run_id === run?.id && e.status === 'awaiting_agent');
  const working = !!run && (['queued', 'running'].includes(run.status) || (run.status === 'waiting' && askingAgent));
  // A task another agent asked: link back to the task that asked.
  const parent = useLive<Session>({ table: 'sessions', eq: { id: s?.parent_session_id ?? undefined }, enabled: !!s?.parent_session_id });
  const asker = parent.rows[0];
  const plan = useMemo(() => {
    const p = [...latestPlan.rows].sort((a, b) => b.seq - a.seq)[0];
    return (p?.data.items as PlanItem[] | undefined) ?? null;
  }, [latestPlan.rows]);
  const liveShot = live.rows.find((l) => l.run_id === run?.id) ?? live.rows[0];
  const shareable = files.rows.filter((f) => f.kind !== 'screenshot');
  const usage = runs.rows.reduce((n, r) => n + (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0), 0);
  const askingQuestion = events.rows.some((e) => e.type === 'tool' && e.status === 'awaiting_input');
  // Paused by a plan's usage limit (not by the user): the newest limit line of the run says so, and the run
  // says whether it carries on by itself (wake_at) or waits for the user.
  const limitLine = run?.status === 'paused' && !run.pause_requested ? events.rows.findLast((e) => e.run_id === run.id && e.type === 'status' && e.data.code === 'usage_limit') : undefined;
  const limitWake = limitLine && run?.wake_at ? Date.parse(run.wake_at) : 0;
  const limitReset = Number(limitLine?.data.resetAt) || 0;
  const device = devices.find((d) => d.id === s?.device_id);
  // A desktop task whose computer is offline hasn't started: say so, rather than "Thinking…".
  const waitingForComputer = !!run && run.status === 'queued' && s?.runtime === 'desktop' && !(device && isLiveDevice(device));
  const toolRunning = working && (askingAgent || events.rows.some((e) => e.type === 'tool' && e.run_id === run?.id && e.status === 'running'));
  const mood: Mood =
    sessionApprovals.length || askingQuestion || s?.status === 'waiting'
      ? 'waiting'
      : waitingForComputer
        ? 'idle'
        : working
        ? toolRunning
          ? 'working'
          : 'thinking'
        : s?.status === 'completed'
          ? 'success'
          : s?.status === 'failed'
            ? 'error'
            : 'idle';

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.rows, sessionApprovals.length]);

  // On a phone the keyboard covers the home-indicator area, but the page still keeps that inset as
  // padding under the composer (a gap above the keyboard): mark the keyboard as open so it's dropped.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => root.toggleAttribute('data-keyboard', vv.scale < 1.05 && Math.max(window.innerHeight, root.clientHeight) - vv.height > 150);
    vv.addEventListener('resize', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      root.removeAttribute('data-keyboard');
    };
  }, []);

  if (session.loading) return <SessionSkeleton />;
  if (!s)
    return (
      <div className="flex min-h-dvh items-center justify-center px-4">
        <EmptyState
          art={<AgentCharacter character="pip" color="slate" size={72} mood="thinking" seed="missing" />}
          title="This task isn’t here"
          action={
            <>
              <ButtonLink href="/app">Go home</ButtonLink>
              <ButtonLink href="/app/inbox" variant="secondary">
                Open inbox
              </ButtonLink>
            </>
          }
        >
          It may have been deleted, or the link is from another account.
        </EmptyState>
      </div>
    );

  const act = async (action: 'pause' | 'resume' | 'cancel' | 'hold') => {
    if (!run) return;
    try {
      const { done } = await api<{ done?: boolean }>(`/api/runs/${run.id}/${action}`, { body: {} });
      if (action === 'cancel') toast(done ? 'Stopped.' : 'Stopping…', done ? 'success' : undefined);
      else if (action === 'pause') toast(done ? 'Paused.' : 'Pausing after the current step…', done ? 'success' : undefined);
      else if (action === 'hold') toast('It stays paused until you resume it.');
      else toast('Resuming…');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const sidePanel = (
    <div className="space-y-4">
      {liveShot?.image && (
        <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="flex gap-1">
              <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
              <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
              <span className="h-2.5 w-2.5 rounded-full bg-border-strong" />
            </span>
            <span className="min-w-0 flex-1 truncate rounded-md bg-bg-subtle px-2 py-0.5 text-[11.5px] text-muted">{liveShot.url}</span>
            {working && <span className="h-2 w-2 animate-wren-pulse rounded-full bg-success" title="Live" />}
          </div>
          <img src={`data:image/jpeg;base64,${liveShot.image}`} alt={`Agent's browser: ${liveShot.title ?? ''}`} className="block w-full" />
          <p className="px-3 py-1.5 text-[11.5px] text-faint">Agent’s browser · updated {timeAgo(liveShot.updated_at)}</p>
        </div>
      )}
      {plan && plan.length > 0 && <PlanCard items={plan} />}
      {shareable.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface p-4 shadow-card">
          <h3 className="mb-2 text-sm font-semibold">Files</h3>
          <ul className="space-y-1">
            {shareable.map((f) => (
              <li key={f.id}>
                {f.kind === 'page' ? (
                  <Link href={`/app/page/${f.id}`} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px] hover:bg-bg-subtle">
                    <LayoutTemplate className="h-4 w-4 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate">{f.name.replace(/\.html$/, '')}</span>
                    <span className="text-[11.5px] text-faint">Page</span>
                    <Maximize2 className="h-3.5 w-3.5 text-faint" />
                  </Link>
                ) : (
                  <a href={`/api/files/${f.id}?download`} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px] hover:bg-bg-subtle">
                    <FileText className="h-4 w-4 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <span className="text-[11.5px] text-faint">{formatBytes(f.size)}</span>
                    <Download className="h-3.5 w-3.5 text-faint" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="rounded-2xl border border-border p-4 text-[12.5px] text-muted">
        <div className="flex justify-between py-0.5">
          <span>Model</span>
          <span className="truncate pl-3 text-right text-text">{modelLabel(run?.model?.source, run?.model?.model)}</span>
        </div>
        <div className="flex justify-between py-0.5">
          <span>Runs on</span>
          <span className="text-text">{s.runtime === 'cloud' ? 'Cloud computer' : device?.name ?? 'Your computer'}</span>
        </div>
        <div className="flex justify-between py-0.5">
          <span>Steps</span>
          <span className="text-text tabular-nums">{steps}</span>
        </div>
        <div className="flex justify-between py-0.5">
          <span>Tokens</span>
          <span className="text-text tabular-nums">{formatTokens(usage)}</span>
        </div>
      </div>
    </div>
  );

  return (
    // Exactly the window, never more: the page itself must not scroll (only the panes inside do).
    <div className="relative flex h-dvh flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b border-border bg-bg/90 px-3 py-2.5 backdrop-blur-md sm:px-5" style={{ paddingTop: 'max(env(safe-area-inset-top), 10px)' }}>
        <button onClick={() => (history.length > 1 ? router.back() : router.push('/app'))} className="rounded-lg p-1.5 text-muted hover:bg-bg-subtle" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Link href={agent ? `/app/agents/${agent.id}` : '/app'} className="shrink-0 rounded-full" aria-label={agent ? `${agent.name}: agent page` : 'Home'}>
          <AgentAvatar icon={agent?.icon} color={agent?.color} size={38} mood={mood} seed={agent?.id} />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">{s.title}</p>
          <p className="flex items-center gap-1.5 truncate text-[12px] text-faint">
            {agent?.name}
            <span>·</span>
            {s.runtime === 'cloud' ? <Cloud className="h-3 w-3" /> : <Laptop className="h-3 w-3" />}
            {s.runtime === 'cloud' ? 'Cloud' : device?.name ?? 'Computer'}
          </p>
        </div>
        <StatusPill status={s.status} computerOffline={waitingForComputer} className="hidden sm:inline-flex" />
        {run && ['queued', 'running'].includes(run.status) && (
          <Button size="sm" variant="secondary" onClick={() => act('pause')} title="Pause">
            <Pause className="h-4 w-4" />
            <span className="hidden sm:inline">Pause</span>
          </Button>
        )}
        {run?.status === 'paused' && (
          <Button size="sm" variant="secondary" onClick={() => act('resume')}>
            <Play className="h-4 w-4" />
            <span className="hidden sm:inline">Resume</span>
          </Button>
        )}
        {run && ['queued', 'running', 'waiting', 'paused'].includes(run.status) && (
          <Button size="sm" variant="secondary" onClick={() => act('cancel')} title="Stop">
            <Square className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Stop</span>
          </Button>
        )}
        <DetailsToggle />
        <Menu
          trigger={(p) => (
            <button type="button" {...p} className="rounded-lg p-1.5 text-muted transition-colors hover:bg-bg-subtle hover:text-text" aria-label="More actions">
              <MoreHorizontal className="h-5 w-5" aria-hidden />
            </button>
          )}
          items={[
            {
              label: s.archived_at ? 'Unarchive' : 'Archive',
              icon: Archive,
              onSelect: async () => {
                try {
                  await api(`/api/sessions/${id}`, { method: 'PATCH', body: { archived: !s.archived_at } });
                  toast(s.archived_at ? 'Moved back to your tasks' : 'Archived', 'success');
                } catch (e) {
                  toast((e as Error).message, 'error');
                }
              },
            },
            {
              label: 'Delete',
              icon: Trash2,
              danger: true,
              onSelect: async () => {
                const ok = await confirm({ title: 'Delete this task?', body: 'Its whole history goes too. Files it shared stay in Files.', confirmLabel: 'Delete task', danger: true });
                if (!ok) return;
                try {
                  await api(`/api/sessions/${id}`, { method: 'DELETE' });
                  toast('Task deleted', 'success');
                  router.replace('/app');
                } catch (e) {
                  toast((e as Error).message, 'error');
                }
              },
            },
          ]}
        />
      </header>

      <div className="flex border-b border-border lg:hidden" role="tablist" aria-label="Task views">
        {(['activity', 'screen', 'files'] as const).map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={panel === p}
            onClick={() => setPanel(p)}
            className={cx('-mb-px flex flex-1 items-center justify-center gap-1.5 border-b-2 py-2.5 text-[13px] font-medium capitalize transition-colors', panel === p ? 'border-text text-text' : 'border-transparent text-faint hover:text-muted')}
          >
            {p === 'screen' ? 'Details' : p}
            {p === 'files' && shareable.length > 0 && <span className="rounded-full bg-bg-subtle px-1.5 text-[11px] text-muted tabular-nums">{shareable.length}</span>}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className={cx('flex min-w-0 flex-1 flex-col', panel !== 'activity' && 'hidden lg:flex')}>
          <div
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
            }}
            // relative: absolutely positioned bits inside (sr-only labels) stay in this pane instead of
            // stretching the page below the window; overscroll-contain: scrolling past the end of the
            // chat doesn't carry on to the page.
            className="relative flex-1 overflow-y-auto overscroll-contain px-3 py-6 scrollbar-thin sm:px-6"
          >
            <div className="mx-auto max-w-3xl lg:details-off:max-w-4xl">
              {hasOlder && (
                <div className="mb-6 text-center">
                  <Button variant="secondary" size="sm" onClick={loadOlder} loading={loadingOlder}>
                    Load earlier activity
                  </Button>
                </div>
              )}
              {s.parent_session_id && (
                <p className="mb-5 flex items-center justify-center gap-2 text-center text-[12.5px] text-muted" role="note">
                  <AgentAvatar icon={agentById(asker?.agent_id)?.icon} color={agentById(asker?.agent_id)?.color} size={20} still seed={asker?.agent_id} />
                  <span>
                    {agentById(asker?.agent_id)?.name ?? 'Another agent'} asked this
                    {asker ? (
                      <>
                        {' '}while working on{' '}
                        <Link href={`/app/s/${asker.id}`} title={asker.title} className="font-medium text-text underline decoration-border-strong underline-offset-2 hover:decoration-text">
                          {asker.title.length > 60 ? `${asker.title.slice(0, 59).trimEnd()}…` : asker.title}
                        </Link>
                      </>
                    ) : null}
                    . The answer goes back to it.
                  </span>
                </p>
              )}
              {events.loading ? (
                <TimelineSkeleton />
              ) : (
                <Timeline events={events.rows} agent={agent} approvals={sessionApprovals} working={working} waitingFor={waitingForComputer ? (device?.name ?? 'your computer') : undefined} stoppedRuns={runs.rows.filter((r) => r.status === 'cancelled').map((r) => r.id)} endedRuns={runs.rows.filter((r) => ['completed', 'failed', 'cancelled'].includes(r.status)).map((r) => r.id)} cleaningRuns={runs.rows.filter((r) => r.cleanup_pending).map((r) => r.id)} />
              )}
              {run?.status === 'failed' && run.error && !events.rows.some((e) => e.type === 'status' && e.data.text === run.error) && <p className="mt-4 text-center text-sm text-danger">{run.error}</p>}
            </div>
          </div>
          <div className="border-t border-border bg-bg px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] kb-open:pb-3 sm:px-6">
            <div className="mx-auto max-w-3xl lg:details-off:max-w-4xl">
              {limitLine && (
                <div role="status" className={cx('mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-3.5 py-2.5 text-[13px]', limitWake ? 'bg-bg-subtle text-muted' : 'bg-warning-soft text-warning')}>
                  <Clock className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">
                    {limitWake ? `Paused at a usage limit. It carries on ${whenLabel(limitWake)}.` : `Paused at a usage limit${limitReset ? `, which resets ${whenLabel(limitReset)}` : ''}. Resume it when you’re ready.`}
                  </span>
                  {limitWake ? (
                    <span className="flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => act('resume')}>
                        Resume now
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => act('hold')}>
                        Don’t resume
                      </Button>
                    </span>
                  ) : null}
                </div>
              )}
              {agent ? (
                <Composer
                  agent={agent}
                  sessionId={id}
                  compact
                  placeholder={askingQuestion ? 'Answer the question…' : waitingForComputer ? 'Add to the task before it starts…' : working ? 'Add guidance while it works…' : 'Follow up or give a new instruction…'}
                  onSent={() => {
                    stick.current = true;
                  }}
                />
              ) : (
                <p className="text-center text-sm text-muted">This agent was removed.</p>
              )}
            </div>
          </div>
        </div>
        <aside id="task-details" aria-label="Task details" className={cx('relative w-full shrink-0 overflow-y-auto overscroll-contain border-l border-border p-4 scrollbar-thin lg:block lg:w-[360px] xl:w-[400px] details-off:lg:hidden', panel === 'activity' ? 'hidden' : 'block')}>
          {panel === 'files' ? (
            shareable.length ? (
              sidePanel
            ) : (
              <EmptyState icon={<FileText className="h-6 w-6" />} title="No files yet">
                Reports, exports and other files the agent shares will appear here.
              </EmptyState>
            )
          ) : (
            sidePanel
          )}
        </aside>
      </div>
    </div>
  );
}

function SessionSkeleton() {
  return (
    <div className="relative flex h-dvh flex-col overflow-hidden" aria-busy="true">
      <div className="flex items-center gap-3 border-b border-border px-3 py-3 sm:px-5">
        <Skeleton className="h-7 w-7 rounded-lg" />
        <Skeleton className="h-9 w-9 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-4 w-1/2 max-w-xs" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl flex-1 px-3 py-6 sm:px-6">
        <TimelineSkeleton />
      </div>
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading activity">
      <div className="flex justify-end">
        <Skeleton className="h-11 w-2/3 rounded-[20px]" />
      </div>
      <div className="flex gap-3">
        <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}

/** Shows or hides the details panel beside the conversation (wide screens; phones use the tabs). */
function DetailsToggle() {
  const hidden = usePaneCollapsed('details');
  const mac = useIsMac();
  const label = hidden ? 'Show details' : 'Hide details';
  return (
    <button
      type="button"
      onClick={() => togglePane('details')}
      aria-label={label}
      aria-expanded={!hidden}
      aria-controls="task-details"
      title={`${label} (${mac ? '⇧⌘' : 'Ctrl+Shift+'}\\)`}
      className="hidden rounded-lg p-1.5 text-muted transition-colors hover:bg-bg-subtle hover:text-text lg:inline-flex"
    >
      <PanelRightClose className="h-5 w-5 details-off:hidden" aria-hidden />
      <PanelRightOpen className="hidden h-5 w-5 details-off:block" aria-hidden />
    </button>
  );
}
