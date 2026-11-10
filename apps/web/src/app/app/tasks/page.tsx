'use client';

import { Archive, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '@/components/app/provider';
import { SessionList } from '@/components/app/session-list';
import { Button, EmptyState, PageHeader, SkeletonList, Tabs } from '@/components/ui';
import { useLive } from '@/lib/client/live';
import type { Session } from '@/lib/client/types';

const PAGE = 30;

// Every task, newest first, and the archived ones. Home shows only the latest few and an agent's page
// only its own, so an older task, a removed agent's, or anything archived had no way back to it.
export default function TasksPage() {
  const { userId } = useApp();
  const [view, setView] = useState<'tasks' | 'archived'>('tasks');
  const [shown, setShown] = useState(PAGE);
  const archived = view === 'archived';
  // One more than shown, to know whether there are more.
  const sessions = useLive<Session>({
    table: 'sessions',
    eq: { user_id: userId },
    ...(archived ? { notNull: ['archived_at'] } : { is: { archived_at: null } }),
    order: { column: 'last_event_at' },
    limit: shown + 1,
    realtimeFilter: { column: 'user_id', value: userId },
  });
  // While the other view loads, the rows still here are the previous view's: show only what belongs.
  const rows = sessions.rows.filter((s) => !!s.archived_at === archived);
  return (
    <div>
      <PageHeader title="Tasks" subtitle="Everything your agents have worked on, newest first." />
      <Tabs
        value={view}
        onChange={(v) => (setView(v), setShown(PAGE))}
        items={[
          { value: 'tasks', label: 'Tasks' },
          { value: 'archived', label: 'Archived' },
        ]}
      />
      <div className="mt-6 space-y-3">
        {sessions.loading ? (
          <SkeletonList rows={6} />
        ) : !rows.length ? (
          archived ? (
            <EmptyState icon={<Archive className="h-6 w-6" />} title="Nothing archived">
              Tasks you archive (from a task’s ⋯ menu) are kept here. Open one to move it back.
            </EmptyState>
          ) : (
            <EmptyState icon={<ListChecks className="h-6 w-6" />} title="No tasks yet">
              Tasks you start show up here.
            </EmptyState>
          )
        ) : (
          <>
            <SessionList sessions={rows.slice(0, shown)} />
            {rows.length > shown && (
              <div className="text-center">
                <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE)}>
                  Show more tasks
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
