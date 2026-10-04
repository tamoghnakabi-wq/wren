'use client';

import Link from 'next/link';
import { AlertTriangle, Bell, CheckCircle2, CircleHelp, Hand } from 'lucide-react';
import { useEffect } from 'react';
import { ApprovalCard } from '@/components/app/approval-card';
import { useApp } from '@/components/app/provider';
import { Button, cx, EmptyState, PageHeader, timeAgo } from '@/components/ui';
import { api } from '@/lib/client/api';

const ICON: Record<string, typeof Bell> = { run_completed: CheckCircle2, run_failed: AlertTriangle, approval: Hand, question: CircleHelp };

export default function InboxPage() {
  const { approvals, notifications, unread } = useApp();

  // Opening the inbox marks notifications as read after a moment.
  useEffect(() => {
    if (!unread) return;
    const t = setTimeout(() => api('/api/notifications/read', { body: { all: true } }).catch(() => {}), 2500);
    return () => clearTimeout(t);
  }, [unread]);

  return (
    <div>
      <PageHeader title="Inbox" subtitle="Approvals and updates from your agents." actions={unread > 0 ? <Button variant="secondary" size="sm" onClick={() => api('/api/notifications/read', { body: { all: true } })}>Mark all read</Button> : null} />
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
      <section>
        <h2 className="mb-3 text-[13px] font-semibold tracking-wide text-faint uppercase">Updates</h2>
        {notifications.length ? (
          <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
            {notifications.map((n) => {
              const Icon = ICON[n.kind] ?? Bell;
              return (
                <li key={n.id}>
                  <Link href={n.url ?? '/app'} className="flex items-start gap-3 px-4 py-3 hover:bg-surface-2">
                    <Icon className={cx('mt-0.5 h-5 w-5 shrink-0', n.kind === 'run_failed' ? 'text-danger' : n.kind === 'approval' || n.kind === 'question' ? 'text-warning' : n.kind === 'run_completed' ? 'text-success' : 'text-faint')} />
                    <div className="min-w-0 flex-1">
                      <p className={cx('text-sm', !n.read_at && 'font-semibold')}>{n.title}</p>
                      {n.body && <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{n.body}</p>}
                    </div>
                    <span className="shrink-0 text-[12px] text-faint">{timeAgo(n.created_at)}</span>
                    {!n.read_at && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" />}
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState icon={<Bell className="h-6 w-6" />} title="You're all caught up">
            When agents finish, have questions, or need approval, it shows up here and on your phone.
          </EmptyState>
        )}
      </section>
    </div>
  );
}
