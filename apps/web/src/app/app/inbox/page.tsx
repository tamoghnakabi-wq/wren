'use client';

import Link from 'next/link';
import { AlertTriangle, Bell, CheckCircle2, CircleHelp, Hand } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AgentCharacter } from '@/components/agent-character';
import { ApprovalCard } from '@/components/app/approval-card';
import { useApp } from '@/components/app/provider';
import { Button, cx, EmptyState, PageHeader, timeAgo } from '@/components/ui';
import { api } from '@/lib/client/api';
import type { Notification } from '@/lib/client/types';

const PAGE = 30;

/** Today / Yesterday / Earlier, in the order the updates arrive (newest first). */
function byDay(list: Notification[]): { label: string; items: Notification[] }[] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const yesterday = today - 86_400_000;
  const groups: { label: string; items: Notification[] }[] = [];
  for (const n of list) {
    const t = new Date(n.created_at).getTime();
    const label = t >= today ? 'Today' : t >= yesterday ? 'Yesterday' : 'Earlier';
    const g = groups[groups.length - 1];
    if (g?.label === label) g.items.push(n);
    else groups.push({ label, items: [n] });
  }
  return groups;
}

const ICON: Record<string, typeof Bell> = { run_completed: CheckCircle2, run_failed: AlertTriangle, approval: Hand, question: CircleHelp };

export default function InboxPage() {
  const { approvals, notifications, unread } = useApp();
  const [shown, setShown] = useState(PAGE);
  const [marking, setMarking] = useState(false);
  const groups = useMemo(() => byDay(notifications.slice(0, shown)), [notifications, shown]);

  // Opening the inbox marks notifications as read after a moment.
  useEffect(() => {
    if (!unread) return;
    const t = setTimeout(() => api('/api/notifications/read', { body: { all: true } }).catch(() => {}), 2500);
    return () => clearTimeout(t);
  }, [unread]);

  return (
    <div>
      <PageHeader
        title="Inbox"
        subtitle="Approvals and updates from your agents."
        actions={
          unread > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              loading={marking}
              onClick={async () => {
                setMarking(true);
                await api('/api/notifications/read', { body: { all: true } }).catch(() => {});
                setMarking(false);
              }}
            >
              Mark all read
            </Button>
          ) : null
        }
      />
      {approvals.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-[13px] font-semibold tracking-wide text-faint uppercase">Waiting for your approval</h2>
          <div className="space-y-3">
            {approvals.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </div>
        </section>
      )}
      <section className="space-y-6">
        {notifications.length ? (
          groups.map((g) => (
            <div key={g.label}>
              <h2 className="mb-3 text-[13px] font-semibold tracking-wide text-faint uppercase">{g.label}</h2>
              <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
            {g.items.map((n) => {
              const Icon = ICON[n.kind] ?? Bell;
              return (
                <li key={n.id}>
                  <Link href={n.url ?? '/app'} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2">
                    <Icon aria-hidden className={cx('mt-0.5 h-5 w-5 shrink-0', n.kind === 'run_failed' ? 'text-danger' : n.kind === 'approval' || n.kind === 'question' ? 'text-warning' : n.kind === 'run_completed' ? 'text-success' : 'text-faint')} />
                    <div className="min-w-0 flex-1">
                      <p className={cx('text-sm', !n.read_at && 'font-semibold')}>
                        {!n.read_at && <span className="sr-only">Unread: </span>}
                        {n.title}
                      </p>
                      {n.body && <p className="mt-0.5 line-clamp-2 text-[13px] break-words text-muted">{n.body}</p>}
                    </div>
                    <span className="shrink-0 text-[12px] text-faint tabular-nums">{timeAgo(n.created_at)}</span>
                    {!n.read_at && <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" />}
                  </Link>
                </li>
              );
            })}
              </ul>
            </div>
          ))
        ) : (
          <EmptyState art={<AgentCharacter character="pip" color="orange" size={64} mood="success" seed="inbox" />} title="You’re all caught up">
            When agents finish, have questions, or need approval, it shows up here and on your phone.
          </EmptyState>
        )}
        {notifications.length > shown && (
          <div className="text-center">
            <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE)}>
              Show older updates
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
