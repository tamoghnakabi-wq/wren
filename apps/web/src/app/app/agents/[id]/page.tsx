'use client';

import { useParams, useRouter } from 'next/navigation';
import { Brain, CalendarClock, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AgentAvatar } from '@/components/agent-avatar';
import { CHARACTERS, characterFor, type Mood } from '@/lib/characters';
import { AgentForm, draftFromAgent, toPayload, type AgentDraft } from '@/components/app/agent-form';
import { Composer } from '@/components/app/composer';
import { useApp } from '@/components/app/provider';
import { SessionList } from '@/components/app/session-list';
import { Button, ButtonLink, EmptyState, Skeleton, SkeletonList, Tabs, timeAgo, useConfirm, useToast } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useLive } from '@/lib/client/live';
import { modelLabel } from '@/lib/client/sources';
import type { Schedule, Session } from '@/lib/client/types';
import { describeCronClient } from '@/lib/client/cron';

export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  const { agentById, agentsLoading, userId } = useApp();
  const router = useRouter();
  const agent = agentById(id);
  const [tab, setTab] = useState<'tasks' | 'settings' | 'memory' | 'schedules'>('tasks');
  const [shown, setShown] = useState(15);
  const sessions = useLive<Session>({ table: 'sessions', eq: { agent_id: id }, is: { archived_at: null }, order: { column: 'last_event_at' }, limit: 50, realtimeFilter: { column: 'agent_id', value: id } });

  if (agentsLoading)
    return (
      <div aria-busy="true">
        <div className="mb-6 flex items-center gap-4">
          <Skeleton className="h-16 w-16 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-3.5 w-28" />
          </div>
        </div>
        <SkeletonList rows={4} avatar={false} />
      </div>
    );
  if (!agent)
    return (
      <EmptyState title="Agent not found" action={<ButtonLink href="/app/agents" variant="secondary">All agents</ButtonLink>}>
        It may have been deleted.
      </EmptyState>
    );

  return (
    <div>
      <div className="mb-6 flex items-center gap-4">
        <AgentAvatar icon={agent.icon} color={agent.color} size={64} mood={agentMood(sessions.rows)} seed={agent.id} title={`${agent.name} the ${CHARACTERS[characterFor(agent.icon)].name}`} />
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{agent.name}</h1>
          <p className="truncate text-sm text-muted">{modelLabel(agent.model?.source, agent.model?.model)}</p>
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'tasks', label: 'Tasks' },
          { value: 'settings', label: 'Settings' },
          { value: 'memory', label: 'Memory' },
          { value: 'schedules', label: 'Schedules' },
        ]}
      />
      <div className="mt-6">
        {tab === 'tasks' && (
          <div className="space-y-6">
            <Composer agent={agent} onSent={(r) => router.push(`/app/s/${r.sessionId}`)} />
            {sessions.loading ? (
              <SkeletonList rows={4} avatar={false} />
            ) : (
              <div className="space-y-3">
                <SessionList sessions={sessions.rows.slice(0, shown)} showAgent={false} empty={<p className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">No tasks yet. Give {agent.name} something to do.</p>} />
                {sessions.rows.length > shown && (
                  <div className="text-center">
                    <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + 15)}>
                      Show more tasks
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {tab === 'settings' && <AgentSettings key={agent.id} />}
        {tab === 'memory' && <MemoryTab agentId={id} userId={userId} />}
        {tab === 'schedules' && <AgentSchedules agentId={id} />}
      </div>
    </div>
  );
}

function AgentSettings() {
  const { id } = useParams<{ id: string }>();
  const { agentById } = useApp();
  const agent = agentById(id)!;
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<AgentDraft>(() => draftFromAgent(agent));
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(toPayload(draft)) !== JSON.stringify(toPayload(draftFromAgent(agent)));
  return (
    <div className="mx-auto max-w-2xl">
      <AgentForm draft={draft} onChange={setDraft} />
      <div className="mt-10 flex items-center justify-between gap-2 border-t border-border pt-6">
        <Button
          variant="ghost"
          className="text-danger"
          onClick={async () => {
            const ok = await confirm({ title: `Delete ${agent.name}?`, body: 'Its cloud computer and schedules are removed. Past tasks stay in your history.', confirmLabel: 'Delete agent', danger: true });
            if (!ok) return;
            try {
              await api(`/api/agents/${agent.id}`, { method: 'DELETE' });
              toast(`${agent.name} was deleted`, 'success');
              router.replace('/app/agents');
            } catch (e) {
              toast((e as Error).message, 'error');
            }
          }}
        >
          <Trash2 className="h-4 w-4" /> Delete agent
        </Button>
        <Button
          disabled={!dirty}
          loading={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await api(`/api/agents/${agent.id}`, { method: 'PATCH', body: toPayload(draft) });
              toast('Saved', 'success');
            } catch (e) {
              toast((e as Error).message, 'error');
            } finally {
              setSaving(false);
            }
          }}
        >
          Save changes
        </Button>
      </div>
    </div>
  );
}

function MemoryTab({ agentId, userId }: { agentId: string; userId: string }) {
  const toast = useToast();
  const mem = useLive<{ id: string; content: string; created_at: string }>({ table: 'agent_memories', eq: { agent_id: agentId, user_id: userId }, order: { column: 'created_at' } });
  if (mem.loading) return <SkeletonList rows={3} avatar={false} />;
  if (!mem.rows.length)
    return (
      <EmptyState icon={<Brain className="h-6 w-6" />} title="Nothing remembered yet">
        As you work together, the agent saves durable preferences and facts here. You can delete anything.
      </EmptyState>
    );
  return (
    <ul className="divide-y divide-border rounded-2xl border border-border bg-surface shadow-card">
      {mem.rows.map((m) => (
        <li key={m.id} className="flex items-start gap-3 px-4 py-3">
          <Brain className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
          <div className="min-w-0 flex-1">
            <p className="text-sm">{m.content}</p>
            <p className="mt-0.5 text-[12px] text-faint">{timeAgo(m.created_at)}</p>
          </div>
          <button
            className="rounded-md p-1 text-faint hover:bg-bg-subtle hover:text-danger"
            aria-label={`Forget: ${m.content.slice(0, 60)}`}
            onClick={async () => {
              try {
                await api(`/api/agents/${agentId}/memories/${m.id}`, { method: 'DELETE' });
                toast('Forgotten', 'success');
              } catch (e) {
                toast((e as Error).message, 'error');
              }
              mem.reload();
            }}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function AgentSchedules({ agentId }: { agentId: string }) {
  const { userId } = useApp();
  const s = useLive<Schedule>({ table: 'schedules', eq: { agent_id: agentId, user_id: userId }, order: { column: 'next_run_at', ascending: true } });
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  if (s.loading) return <SkeletonList rows={2} avatar={false} />;
  return (
    <div className="space-y-3">
      {s.rows.map((x) => (
        <div key={x.id} className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3 shadow-card">
          <CalendarClock className="h-5 w-5 text-faint" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{x.name}</p>
            <p className="text-[12.5px] text-muted">
              {describeCronClient(x.cron)} · {x.enabled ? (x.next_run_at ? `next ${new Date(x.next_run_at).toLocaleString()}` : 'pending') : 'paused'}
            </p>
          </div>
        </div>
      ))}
      <ButtonLink href={`/app/schedules?agent=${agentId}`} variant="secondary">
        <CalendarClock className="h-4 w-4" aria-hidden /> {s.rows.length ? 'Manage schedules' : 'Add a schedule'}
      </ButtonLink>
    </div>
  );
}

/** What the agent looks like right now: busy, waiting, or how its latest task went. */
function agentMood(sessions: Session[]): Mood {
  if (sessions.some((s) => s.status === 'running' || s.status === 'queued')) return 'working';
  if (sessions.some((s) => s.status === 'waiting')) return 'waiting';
  const latest = sessions[0];
  const recent = latest && Date.now() - new Date(latest.last_event_at).getTime() < 10 * 60_000;
  if (recent && latest.status === 'completed') return 'success';
  if (recent && latest.status === 'failed') return 'error';
  return 'idle';
}
