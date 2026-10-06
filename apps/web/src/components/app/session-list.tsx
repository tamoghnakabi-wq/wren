'use client';

import Link from 'next/link';
import { Cloud, Laptop } from 'lucide-react';
import { isLiveDevice, type Session } from '@/lib/client/types';
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
        const offline = s.status === 'queued' && s.runtime === 'desktop' && !(dev && isLiveDevice(dev));
        return (
          <li key={s.id}>
            <Link href={`/app/s/${s.id}`} className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2">
              {showAgent && <AgentAvatar icon={a?.icon} color={a?.color} size={36} mood={offline ? 'idle' : sessionMood(s.status)} still={offline || !['running', 'queued', 'waiting'].includes(s.status)} seed={s.id} />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14.5px] font-medium">{s.title}</p>
                {/* Names shrink with an ellipsis; the time always stays visible. */}
                <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] whitespace-nowrap text-faint">
                  {showAgent && a && <span className="max-w-[55%] min-w-0 shrink-0 truncate">{a.name}</span>}
                  {showAgent && a && <span aria-hidden>·</span>}
                  {s.runtime === 'cloud' ? <Cloud className="h-3 w-3 shrink-0" aria-hidden /> : <Laptop className="h-3 w-3 shrink-0" aria-hidden />}
                  <span className="min-w-0 truncate">{s.runtime === 'cloud' ? 'Cloud' : dev?.name ?? 'Computer'}</span>
                  <span aria-hidden>·</span>
                  <span className="shrink-0">{timeAgo(s.last_event_at)}</span>
                </p>
              </div>
              <StatusPill status={s.status} computerOffline={offline} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
