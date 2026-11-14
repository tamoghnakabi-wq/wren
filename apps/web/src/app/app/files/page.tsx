'use client';

import Link from 'next/link';
import { Download, FileText, FolderOpen, Image as ImageIcon, LayoutTemplate, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { AgentAvatar } from '@/components/agent-avatar';
import { useApp } from '@/components/app/provider';
import { Button, cx, EmptyState, formatBytes, PageHeader, SkeletonList, timeAgo, useConfirm, useToast } from '@/components/ui';
import { api } from '@/lib/client/api';
import { useLive } from '@/lib/client/live';
import type { Artifact } from '@/lib/client/types';

const PAGE = 100;
const KIND = { files: 'file', pages: 'page', screenshots: 'screenshot', uploads: 'upload' } as const;

export default function FilesPage() {
  const { userId, agentById } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<'all' | keyof typeof KIND>('files');
  const [shown, setShown] = useState(PAGE);
  // Each view asks for its own kind. The newest 300 of every kind were loaded and filtered here before,
  // so once an agent had taken 300 screenshots (one per browser step), "From agents" came up empty.
  // One more than shown, to know whether there are more.
  const files = useLive<Artifact>({ table: 'artifacts', eq: { user_id: userId, kind: filter === 'all' ? undefined : KIND[filter] }, order: { column: 'created_at' }, limit: shown + 1, realtimeFilter: { column: 'user_id', value: userId } });
  // While another view loads, the rows still here are the previous view's: show only what belongs.
  const all = files.rows.filter((f) => filter === 'all' || f.kind === KIND[filter]);
  const rows = all.slice(0, shown);

  return (
    <div>
      <PageHeader title="Files" subtitle="Reports, exports, pages and screenshots your agents produced, and files you uploaded." />
      <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {(['files', 'pages', 'screenshots', 'uploads', 'all'] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => (setFilter(f), setShown(PAGE))}
            className={cx('rounded-full border px-3 py-1.5 text-[13px] font-medium capitalize transition-colors', filter === f ? 'border-primary bg-primary text-primary-fg' : 'border-border bg-surface text-muted hover:border-border-strong hover:text-text')}
          >
            {f === 'files' ? 'From agents' : f}
          </button>
        ))}
      </div>
      {files.loading ? (
        <SkeletonList rows={5} />
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
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-bg-subtle text-muted">{f.kind === 'screenshot' ? <ImageIcon className="h-5 w-5" /> : f.kind === 'page' ? <LayoutTemplate className="h-5 w-5" /> : <FileText className="h-5 w-5" />}</span>
                )}
                <div className="min-w-0 flex-1">
                  {f.kind === 'page' ? (
                    <Link href={`/app/page/${f.id}`} className="block truncate text-sm font-medium hover:underline hover:underline-offset-2">
                      {f.name.replace(/\.html$/, '')}
                    </Link>
                  ) : (
                    <p className="truncate text-sm font-medium">{f.name}</p>
                  )}
                  <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] whitespace-nowrap text-faint">
                    {a && <AgentAvatar icon={a.icon} color={a.color} size={16} still />}
                    <span className="min-w-0 truncate">{a?.name ?? (f.source === 'user' ? 'You' : 'Agent')}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{formatBytes(f.size)}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{timeAgo(f.created_at)}</span>
                    {f.session_id && (
                      <>
                        <span aria-hidden>·</span>
                        <Link href={`/app/s/${f.session_id}`} className="shrink-0 underline underline-offset-2 hover:text-text">
                          Open task
                        </Link>
                      </>
                    )}
                  </p>
                </div>
                <a href={`/api/files/${f.id}?download`} className="rounded-lg p-2 text-muted transition-colors hover:bg-bg-subtle hover:text-text" aria-label={`Download ${f.name}`}>
                  <Download className="h-4 w-4" />
                </a>
                <button
                  className="rounded-lg p-2 text-faint transition-colors hover:bg-danger-soft hover:text-danger"
                  aria-label={`Delete ${f.name}`}
                  onClick={async () => {
                    const ok = await confirm({ title: `Delete ${f.name}?`, body: 'It is removed from Files and from the task that shared it.', confirmLabel: 'Delete', danger: true });
                    if (!ok) return;
                    try {
                      await api(`/api/files/${f.id}`, { method: 'DELETE' });
                      toast('File deleted', 'success');
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
      {!files.loading && all.length > shown && (
        <div className="mt-3 text-center">
          <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE)}>
            Show more files
          </Button>
        </div>
      )}
    </div>
  );
}
