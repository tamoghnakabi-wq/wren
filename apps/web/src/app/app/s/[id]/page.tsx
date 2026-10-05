'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Archive, Cloud, Download, FileText, Laptop, MoreHorizontal, Pause, Play, Square, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AgentAvatar } from '@/components/agent-avatar';
import type { Mood } from '@/lib/characters';
import { Composer } from '@/components/app/composer';
import { useApp } from '@/components/app/provider';
import { StatusPill } from '@/components/app/status';
import { PlanCard, Timeline } from '@/components/app/timeline';
import { Button, cx, formatBytes, formatTokens, Spinner, timeAgo, useToast } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useLive } from '@/lib/client/live';
import { supabase } from '@/lib/client/supabase';
import { modelLabel } from '@/lib/client/sources';
import type { Artifact, EventRow, PlanItem, Run, RunLive, Session } from '@/lib/client/types';

/** Events per page of task history. */
const PAGE = 500;

export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { agentById, approvals, devices } = useApp();
  const session = useLive<Session>({ table: 'sessions', eq: { id }, realtimeFilter: { column: 'id', value: id } });
  // The newest events stay live; older history loads a page at a time on request (by seq).
  // keepAll: rows that scroll out of the newest page stay, so the timeline has no holes between
  // the live part and the older pages loaded below.
  const eventsLive = useLive<EventRow>({ table: 'events', eq: { session_id: id }, order: { column: 'seq', ascending: false }, limit: PAGE, keepAll: true, realtimeFilter: { column: 'session_id', value: id } });
  const [older, setOlder] = useState<{ session: string; rows: EventRow[]; more: boolean }>({ session: id, rows: [], more: true });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderRows = older.session === id ? older.rows : [];
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
  const runs = useLive<Run>({ table: 'runs', eq: { session_id: id }, order: { column: 'created_at' }, limit: 20, realtimeFilter: { column: 'session_id', value: id } });
  const live = useLive<RunLive>({ table: 'run_live', eq: { session_id: id }, pk: 'run_id', realtimeFilter: { column: 'session_id', value: id } });
  const files = useLive<Artifact>({ table: 'artifacts', eq: { session_id: id }, order: { column: 'created_at' }, realtimeFilter: { column: 'session_id', value: id } });
  const [panel, setPanel] = useState<'activity' | 'screen' | 'files'>('activity');
  const [menu, setMenu] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const s = session.rows[0];
  const agent = agentById(s?.agent_id);
  const run = runs.rows[0];
  // runs.step is only saved when a run stops, so count model turns while it works.
  const turns = new Map<string, number>();
  for (const e of events.rows) if (e.run_id && e.type === 'message' && e.data.role === 'assistant') turns.set(e.run_id, (turns.get(e.run_id) ?? 0) + 1);
  const steps = runs.rows.reduce((n, r) => n + Math.max(r.step, turns.get(r.id) ?? 0), 0);
  const sessionApprovals = approvals.filter((a) => a.session_id === id);
  const working = !!run && ['queued', 'running'].includes(run.status);
  const plan = useMemo(() => {
    const p = [...latestPlan.rows].sort((a, b) => b.seq - a.seq)[0];
    return (p?.data.items as PlanItem[] | undefined) ?? null;
  }, [latestPlan.rows]);
  const liveShot = live.rows.find((l) => l.run_id === run?.id) ?? live.rows[0];
  const shareable = files.rows.filter((f) => f.kind !== 'screenshot');
  const usage = runs.rows.reduce((n, r) => n + (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0), 0);
  const askingQuestion = events.rows.some((e) => e.type === 'tool' && e.status === 'awaiting_input');
  const device = devices.find((d) => d.id === s?.device_id);
  const toolRunning = working && events.rows.some((e) => e.type === 'tool' && e.run_id === run?.id && e.status === 'running');
  const mood: Mood =
    sessionApprovals.length || askingQuestion || s?.status === 'waiting'
      ? 'waiting'
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


  if (session.loading) return <Spinner className="mx-auto mt-32" />;
  if (!s)
    return (
      <div className="p-10 text-center">
        <p className="text-muted">This task doesn’t exist or was deleted.</p>
        <Link href="/app" className="mt-3 inline-block text-sm underline">
          Go home
        </Link>
      </div>
    );

  const act = async (action: 'pause' | 'resume' | 'cancel') => {
    if (!run) return;
    try {
      await api(`/api/runs/${run.id}/${action}`, { body: {} });
      toast(action === 'cancel' ? 'Stopping…' : action === 'pause' ? 'Pausing after the current step…' : 'Resuming…');
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
                <a href={`/api/files/${f.id}?download`} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px] hover:bg-bg-subtle">
                  <FileText className="h-4 w-4 shrink-0 text-faint" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <span className="text-[11.5px] text-faint">{formatBytes(f.size)}</span>
                  <Download className="h-3.5 w-3.5 text-faint" />
                </a>
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
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-2 border-b border-border bg-bg/90 px-3 py-2.5 backdrop-blur-md sm:px-5" style={{ paddingTop: 'max(env(safe-area-inset-top), 10px)' }}>
        <button onClick={() => (history.length > 1 ? router.back() : router.push('/app'))} className="rounded-lg p-1.5 text-muted hover:bg-bg-subtle" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <Link href={agent ? `/app/agents/${agent.id}` : '/app'} className="shrink-0">
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
        <StatusPill status={s.status} className="hidden sm:inline-flex" />
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
        <div className="relative">
          <button onClick={() => setMenu((v) => !v)} className="rounded-lg p-1.5 text-muted hover:bg-bg-subtle" aria-label="More">
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {menu && (
            <div className="animate-in absolute top-10 right-0 z-30 w-44 rounded-xl border border-border bg-surface p-1 shadow-pop" onMouseLeave={() => setMenu(false)}>
              <button
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-bg-subtle"
                onClick={async () => {
                  await api(`/api/sessions/${id}`, { method: 'PATCH', body: { archived: !s.archived_at } });
                  toast(s.archived_at ? 'Unarchived' : 'Archived');
                  setMenu(false);
                }}
              >
                <Archive className="h-4 w-4" /> {s.archived_at ? 'Unarchive' : 'Archive'}
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-danger-soft"
                onClick={async () => {
                  if (!confirm('Delete this task and its history?')) return;
                  try {
                    await api(`/api/sessions/${id}`, { method: 'DELETE' });
                    router.replace('/app');
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  }
                }}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="flex border-b border-border lg:hidden">
        {(['activity', 'screen', 'files'] as const).map((p) => (
          <button key={p} onClick={() => setPanel(p)} className={cx('flex-1 py-2 text-[13px] font-medium capitalize', panel === p ? 'border-b-2 border-text text-text' : 'text-faint')}>
            {p === 'screen' ? 'Details' : p}
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
            className="flex-1 overflow-y-auto px-3 py-6 scrollbar-thin sm:px-6"
          >
            <div className="mx-auto max-w-3xl">
              {hasOlder && (
                <div className="mb-6 text-center">
                  <Button variant="secondary" size="sm" onClick={loadOlder} loading={loadingOlder}>
                    Load earlier activity
                  </Button>
                </div>
              )}
              {events.loading ? <Spinner className="mx-auto" /> : <Timeline events={events.rows} agent={agent} approvals={sessionApprovals} working={working} />}
              {run?.status === 'failed' && run.error && !events.rows.some((e) => e.type === 'status' && e.data.text === run.error) && <p className="mt-4 text-center text-sm text-danger">{run.error}</p>}
            </div>
          </div>
          <div className="pb-safe border-t border-border bg-bg px-3 pt-3 pb-3 sm:px-6">
            <div className="mx-auto max-w-3xl">
              {agent ? (
                <Composer
                  agent={agent}
                  sessionId={id}
                  compact
                  placeholder={askingQuestion ? 'Answer the question…' : working ? 'Add guidance while it works…' : 'Follow up or give a new instruction…'}
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
        <aside className={cx('w-full shrink-0 overflow-y-auto border-l border-border p-4 scrollbar-thin lg:block lg:w-[360px] xl:w-[400px]', panel === 'activity' ? 'hidden' : 'block')}>
          {panel === 'files' ? (
            shareable.length ? (
              sidePanel
            ) : (
              <p className="p-6 text-center text-sm text-muted">Files the agent shares will appear here.</p>
            )
          ) : (
            sidePanel
          )}
        </aside>
      </div>
    </div>
  );
}
