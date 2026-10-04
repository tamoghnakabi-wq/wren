'use client';

import Link from 'next/link';
import { Cloud, Laptop } from 'lucide-react';
import type { Session } from '@/lib/client/types';
import { AgentAvatar, sessionMood } from '../agent-avatar';
import { timeAgo } from '../ui';
import { useApp } from './provider';
import { StatusPill } from './status';

export function SessionList({ sessions, showAgent = true, empty }: { sessions: Session[]; showAgent?: boolean; empty?: React.ReactNode }) {
  const { agentById, devices } = useApp();
  if (!sessions.length) return <>{empty ?? null}</>;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      {sessions.map((s) => {
        const a = agentById(s.agent_id);
        const dev = devices.find((d) => d.id === s.device_id);
        return (
          <li key={s.id}>
            <Link href={`/app/s/${s.id}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-surface-2">
              {showAgent && <AgentAvatar icon={a?.icon} color={a?.color} size={36} mood={sessionMood(s.status)} still={!['running', 'queued', 'waiting'].includes(s.status)} seed={s.id} />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14.5px] font-medium">{s.title}</p>
                <p className="mt-0.5 flex items-center gap-1.5 truncate text-[12.5px] text-faint">
                  {showAgent && a && <span>{a.name}</span>}
                  {showAgent && a && <span>·</span>}
                  {s.runtime === 'cloud' ? <Cloud className="h-3 w-3" /> : <Laptop className="h-3 w-3" />}
                  <span>{s.runtime === 'cloud' ? 'Cloud' : dev?.name ?? 'Computer'}</span>
                  <span>·</span>
                  <span>{timeAgo(s.last_event_at)}</span>
                </p>
              </div>
              <StatusPill status={s.status} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
