'use client';

import { AlertTriangle, CheckCircle2, CircleDashed, CirclePause, CircleX, Clock, Hand, Loader2 } from 'lucide-react';
import type { SessionStatus } from '@/lib/client/types';
import { cx } from '../ui';

const MAP: Record<SessionStatus, { label: string; cls: string; Icon: typeof Clock }> = {
  idle: { label: 'Idle', cls: 'bg-bg-subtle text-muted', Icon: CircleDashed },
  queued: { label: 'Starting', cls: 'bg-info-soft text-info', Icon: Clock },
  running: { label: 'Working', cls: 'bg-success-soft text-success', Icon: Loader2 },
  waiting: { label: 'Needs you', cls: 'bg-warning-soft text-warning', Icon: Hand },
  paused: { label: 'Paused', cls: 'bg-bg-subtle text-muted', Icon: CirclePause },
  completed: { label: 'Done', cls: 'bg-bg-subtle text-muted', Icon: CheckCircle2 },
  failed: { label: 'Failed', cls: 'bg-danger-soft text-danger', Icon: AlertTriangle },
  cancelled: { label: 'Stopped', cls: 'bg-bg-subtle text-faint', Icon: CircleX },
};

export function StatusPill({ status, className }: { status: SessionStatus; className?: string }) {
  const m = MAP[status] ?? MAP.idle;
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium whitespace-nowrap', m.cls, className)}>
      <m.Icon className={cx('h-3.5 w-3.5', status === 'running' && 'animate-spin')} />
      {m.label}
    </span>
  );
}
