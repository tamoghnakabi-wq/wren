'use client';

import Link from 'next/link';
import { Download, FileText, FolderOpen, Image as ImageIcon, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AgentAvatar } from '@/components/agent-avatar';
import { useApp } from '@/components/app/provider';
import { cx, EmptyState, formatBytes, PageHeader, Spinner, timeAgo, useToast } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useLive } from '@/lib/client/live';
import type { Artifact } from '@/lib/client/types';

export default function FilesPage() {
  const { userId, agentById } = useApp();
  const toast = useToast();
  const [filter, setFilter] = useState<'all' | 'files' | 'screenshots' | 'uploads'>('files');
  const files = useLive<Artifact>({ table: 'artifacts', eq: { user_id: userId }, order: { column: 'created_at' }, limit: 300, realtimeFilter: { column: 'user_id', value: userId } });
  const rows = files.rows.filter((f) => (filter === 'all' ? true : filter === 'files' ? f.kind === 'file' : filter === 'screenshots' ? f.kind === 'screenshot' : f.kind === 'upload'));

  return (
    <div>
      <PageHeader title="Files" subtitle="Reports, exports and screenshots your agents produced, and files you uploaded." />
      <div className="mb-4 flex gap-1.5">
        {(['files', 'screenshots', 'uploads', 'all'] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={cx('rounded-full px-3 py-1.5 text-[13px] font-medium capitalize', filter === f ? 'bg-primary text-primary-fg' : 'bg-surface text-muted hover:text-text')}>
            {f === 'files' ? 'From agents' : f}
          </button>
        ))}
      </div>
      {files.loading ? (
        <Spinner />
      ) : !rows.length ? (
        <EmptyState icon={<FolderOpen className="h-6 w-6" />} title="No files yet">
          When an agent shares a document, report, image or export, it lands here.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
          {rows.map((f) => {
            const a = agentById(f.agent_id);
            const img = f.mime.startsWith('image/');
            return (
              <li key={f.id} className="flex items-center gap-3 px-4 py-3">
                {img ? (
                  <a href={`/api/files/${f.id}`} target="_blank" rel="noreferrer" className="shrink-0">
                    <img src={`/api/files/${f.id}`} alt="" loading="lazy" className="h-11 w-11 rounded-lg border border-border object-cover" />
                  </a>
                ) : (
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-bg-subtle text-muted">{f.kind === 'screenshot' ? <ImageIcon className="h-5 w-5" /> : <FileText className="h-5 w-5" />}</span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{f.name}</p>
                  <p className="flex items-center gap-1.5 truncate text-[12.5px] text-faint">
                    {a && <AgentAvatar icon={a.icon} color={a.color} size={14} />}
                    {a?.name ?? (f.source === 'user' ? 'You' : 'Agent')} · {formatBytes(f.size)} · {timeAgo(f.created_at)}
                    {f.session_id && (
                      <Link href={`/app/s/${f.session_id}`} className="underline">
                        task
                      </Link>
                    )}
                  </p>
                </div>
                <a href={`/api/files/${f.id}?download`} className="rounded-lg p-2 text-muted hover:bg-bg-subtle hover:text-text" aria-label={`Download ${f.name}`}>
                  <Download className="h-4 w-4" />
                </a>
                <button
                  className="rounded-lg p-2 text-faint hover:bg-danger-soft hover:text-danger"
                  aria-label={`Delete ${f.name}`}
                  onClick={async () => {
                    if (!confirm(`Delete ${f.name}?`)) return;
                    try {
                      await api(`/api/files/${f.id}`, { method: 'DELETE' });
                      files.reload();
                    } catch (e) {
                      toast((e as Error).message, 'error');
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
