'use client';

import Link from 'next/link';
import { Cloud, Laptop, Plus } from 'lucide-react';
import { AgentAvatar } from '@/components/agent-avatar';
import { AgentCharacter } from '@/components/agent-character';
import { useApp } from '@/components/app/provider';
import { ButtonLink, EmptyState, PageHeader, timeAgo } from '@/components/ui';
import { modelLabel } from '@/lib/client/sources';

export default function AgentsPage() {
  const { agents, active, devices } = useApp();
  return (
    <div>
      <PageHeader
        title="Agents"
        subtitle="Your team of persistent agents. Each one remembers, has its own computer, and can work on its own."
        actions={
          <ButtonLink href="/app/agents/new">
            <Plus className="h-4 w-4" aria-hidden /> New agent
          </ButtonLink>
        }
      />
      {!agents.length ? (
        <EmptyState
          art={
            <span className="flex items-end">
              <AgentCharacter character="kit" color="blue" size={52} seed="e1" />
              <AgentCharacter character="pip" color="orange" size={68} mood="hello" seed="e2" className="-mx-1" />
              <AgentCharacter character="sprout" color="teal" size={52} seed="e3" />
            </span>
          }
          title="No agents yet" action={<ButtonLink href="/app/agents/new">Create an agent</ButtonLink>}>
          Create an agent, give it a name and instructions, and hand it real work.
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map((a) => {
            const sessions = active.filter((s) => s.agent_id === a.id);
            const live = sessions.some((s) => s.status === 'running') ? 'running' : sessions.some((s) => s.status === 'waiting') ? 'waiting' : null;
            const dev = devices.find((d) => d.id === a.device_id);
            return (
              <Link key={a.id} href={`/app/agents/${a.id}`} className="group flex flex-col rounded-2xl border border-border bg-surface p-4 shadow-card transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-pop motion-reduce:hover:translate-y-0">
                <div className="flex items-start gap-3">
                  <AgentAvatar icon={a.icon} color={a.color} size={44} live={live} seed={a.id} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{a.name}</p>
                    <p className="mt-0.5 truncate text-[12.5px] text-muted">{modelLabel(a.model?.source, a.model?.model)}</p>
                  </div>
                </div>
                <p className="mt-3 line-clamp-2 text-[13px] text-muted">{a.instructions || 'No instructions yet.'}</p>
                {/* Pinned to the bottom so footers line up across a row. */}
                <div className="mt-auto flex items-center gap-2 pt-3 text-[12px] whitespace-nowrap text-faint">
                  {a.runtime === 'cloud' ? <Cloud className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <Laptop className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                  <span className="min-w-0 truncate">{a.runtime === 'cloud' ? 'Cloud computer' : dev?.name ?? 'Your computer'}</span>
                  <span className="ml-auto shrink-0">{live === 'running' ? <span className="font-medium text-success">Working</span> : live === 'waiting' ? <span className="font-medium text-warning">Needs you</span> : a.last_active_at ? `Active ${timeAgo(a.last_active_at)}` : 'Not used yet'}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
