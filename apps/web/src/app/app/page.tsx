'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Check, KeyRound, Laptop, Sparkles } from 'lucide-react';
import { Suspense, useMemo, useState } from 'react';
import { ApprovalCard } from '@/components/app/approval-card';
import { Composer } from '@/components/app/composer';
import { useApp } from '@/components/app/provider';
import { SessionList } from '@/components/app/session-list';
import { Card, cx, Skeleton, SkeletonList } from '@/components/ui';
import { useLive } from '@/lib/client/live';
import type { Agent, Connection, Session } from '@/lib/client/types';
import { TEMPLATES } from '@/lib/client/templates';
import { AgentAvatar } from '@/components/agent-avatar';

export default function HomePage() {
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <Home />
    </Suspense>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function Home() {
  const { agents, agentsLoading, approvals, active, profile, userId, devices } = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const [picked, setAgent] = useState<Agent | undefined>();
  const recent = useLive<Session>({ table: 'sessions', eq: { user_id: userId }, is: { archived_at: null }, order: { column: 'last_event_at' }, limit: 15, realtimeFilter: { column: 'user_id', value: userId } });
  const connections = useLive<Connection>({ table: 'connections', eq: { user_id: userId } });

  // The agent you picked, else the one named in the URL, else the most recently active one.
  const fallback = useMemo(() => {
    const pref = params.get('agent');
    const byLast = [...agents].sort((a, b) => String(b.last_active_at ?? b.created_at).localeCompare(String(a.last_active_at ?? a.created_at)));
    return agents.find((a) => a.id === pref) ?? byLast[0];
  }, [agents, params]);
  const agent = picked && agents.some((a) => a.id === picked.id) ? picked : fallback;

  const name = profile?.display_name?.split(' ')[0];
  const waitingNoApproval = active.filter((s) => s.status === 'waiting' && !approvals.some((a) => a.session_id === s.id));
  const hasModel = connections.rows.some((c) => c.kind === 'model') || devices.length > 0 || agents.some((a) => ['platform', 'test'].includes(a.model?.source as string));

  if (agentsLoading) return <HomeSkeleton />;

  return (
    <div className="space-y-10">
      <section className="pt-2 lg:pt-6">
        <h1 className="font-display text-[34px] leading-tight tracking-tight sm:text-[42px]">
          {greeting()}
          {name ? `, ${name}` : ''}.
        </h1>
        <p className="mt-1 text-[15px] text-muted">{agents.length ? 'Give an agent something to do — it will keep working while you are away.' : 'Create your first agent to get started.'}</p>
        <div className="mt-6">
          {agents.length ? (
            <Composer agent={agent} onAgentChange={setAgent} autoFocus={params.get('compose') === '1'} onSent={(r) => router.push(`/app/s/${r.sessionId}`)} />
          ) : (
            <StarterTemplates />
          )}
        </div>
      </section>

      {agents.length > 0 && !hasModel && !connections.loading && (
        <SetupChecklist hasModel={hasModel} hasDevice={devices.length > 0} />
      )}

      {(approvals.length > 0 || waitingNoApproval.length > 0) && (
        <section>
          <SectionTitle>Needs you</SectionTitle>
          <div className="space-y-3">
            {approvals.slice(0, 5).map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
            {waitingNoApproval.length > 0 && <SessionList sessions={waitingNoApproval} />}
          </div>
        </section>
      )}

      {active.filter((s) => s.status !== 'waiting').length > 0 && (
        <section>
          <SectionTitle>Working now</SectionTitle>
          <SessionList sessions={active.filter((s) => s.status !== 'waiting')} />
        </section>
      )}

      {agents.length > 0 && (
        <section>
          <SectionTitle action={<Link href="/app/agents" className="text-[13px] text-muted hover:text-text">All agents →</Link>}>Recent tasks</SectionTitle>
          {recent.loading ? (
            <SkeletonList rows={5} />
          ) : (
            <SessionList
              sessions={recent.rows.filter((s) => !['queued', 'running', 'waiting', 'paused'].includes(s.status))}
              empty={<p className="rounded-2xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted">Finished tasks will show up here.</p>}
            />
          )}
        </section>
      )}
    </div>
  );
}

/** Same shape as the page, so nothing jumps when it loads. */
function HomeSkeleton() {
  return (
    <div className="space-y-10" aria-busy="true">
      <section className="pt-2 lg:pt-6">
        <Skeleton className="h-10 w-72 max-w-full sm:h-12" />
        <Skeleton className="mt-3 h-4 w-96 max-w-full" />
        <Skeleton className="mt-6 h-[118px] w-full rounded-[22px]" />
      </section>
      <section>
        <Skeleton className="mb-3 h-3.5 w-28" />
        <SkeletonList rows={5} />
      </section>
    </div>
  );
}

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[13px] font-semibold tracking-wide text-faint uppercase">{children}</h2>
      {action}
    </div>
  );
}

function SetupChecklist({ hasModel, hasDevice }: { hasModel: boolean; hasDevice: boolean }) {
  const items = [
    { done: hasModel, icon: KeyRound, title: 'Choose how your agents think', body: 'Use your ChatGPT, Claude or Grok plan on your computer, or add an API key for cloud agents.', href: '/app/connections' },
    { done: hasDevice, icon: Laptop, title: 'Install Wren on your Mac or PC', body: 'Lets agents work on your own computer and use your subscriptions.', href: '/download' },
  ];
  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold">Finish setting up</h2>
      <ul className="mt-3 space-y-2">
        {items.map((i) => (
          <li key={i.title}>
            <Link href={i.href} className="flex items-center gap-3 rounded-xl p-2 hover:bg-bg-subtle">
              <span className={cx('flex h-9 w-9 items-center justify-center rounded-xl', i.done ? 'bg-success-soft text-success' : 'bg-bg-subtle text-muted')}>{i.done ? <Check className="h-4.5 w-4.5" /> : <i.icon className="h-4.5 w-4.5" />}</span>
              <span className="min-w-0 flex-1">
                <span className={cx('block text-sm font-medium', i.done && 'text-muted line-through')}>{i.title}</span>
                <span className="block text-[13px] text-muted">{i.body}</span>
              </span>
              <ArrowRight className="h-4 w-4 text-faint" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function StarterTemplates() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {TEMPLATES.map((t) => (
        <Link key={t.id} href={`/app/agents/new?template=${t.id}`} className="group flex items-start gap-3 rounded-2xl border border-border bg-surface p-4 shadow-card transition hover:border-border-strong hover:shadow-pop">
          <AgentAvatar icon={t.icon} color={t.color} size={40} />
          <span className="min-w-0">
            <span className="block font-semibold">{t.name}</span>
            <span className="mt-0.5 block text-[13px] text-muted">{t.tagline}</span>
          </span>
        </Link>
      ))}
      <Link href="/app/agents/new" className="flex items-center gap-3 rounded-2xl border border-dashed border-border-strong p-4 text-muted transition hover:bg-surface hover:text-text">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-subtle">
          <Sparkles className="h-5 w-5" />
        </span>
        <span className="font-medium">Start from scratch</span>
      </Link>
    </div>
  );
}
