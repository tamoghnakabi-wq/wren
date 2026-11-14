'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Download, LayoutTemplate } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AgentAvatar } from '@/components/agent-avatar';
import { PageFrame } from '@/components/app/page-frame';
import { useApp } from '@/components/app/provider';
import { ButtonLink, EmptyState, Skeleton, timeAgo } from '@/components/ui';
import { supabase } from '@/lib/client/supabase';
import type { Artifact } from '@/lib/client/types';

/** A page an agent made (task.show_page), on its own: the page fills the window under a bar saying whose it is. */
export default function AgentPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { agentById } = useApp();
  const [page, setPage] = useState<Artifact | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    supabase()
      .from('artifacts')
      .select('id, agent_id, session_id, name, mime, size, kind, source, created_at')
      .eq('id', id)
      .eq('kind', 'page')
      .maybeSingle()
      .then(({ data }) => live && setPage((data as Artifact | null) ?? null));
    return () => {
      live = false;
    };
  }, [id]);

  if (page === null)
    return (
      <div className="flex h-dvh items-center justify-center">
        <EmptyState
          icon={<LayoutTemplate className="h-6 w-6" />}
          title="Page not found"
          action={
            <ButtonLink href="/app/files" variant="secondary">
              Open Files
            </ButtonLink>
          }
        >
          It may have been deleted, or the link is from another account.
        </EmptyState>
      </div>
    );

  const agent = agentById(page?.agent_id ?? null);
  const title = page ? page.name.replace(/\.html$/, '') : '';
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex items-center gap-2 border-b border-border bg-bg/90 px-3 py-2.5 backdrop-blur-md sm:px-5" style={{ paddingTop: 'max(env(safe-area-inset-top), 10px)' }}>
        <button onClick={() => (history.length > 1 ? router.back() : router.push(page?.session_id ? `/app/s/${page.session_id}` : '/app'))} className="rounded-lg p-1.5 text-muted hover:bg-bg-subtle" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </button>
        {agent && <AgentAvatar icon={agent.icon} color={agent.color} size={30} still seed={agent.id} />}
        <div className="min-w-0 flex-1">
          {page ? <p className="truncate text-[15px] font-semibold">{title}</p> : <Skeleton className="h-4 w-48" />}
          {page && (
            <p className="truncate text-[12px] text-faint">
              {agent ? `Made by ${agent.name}` : 'Made by an agent'} · {timeAgo(page.created_at)}
              {page.session_id && (
                <>
                  {' · '}
                  <Link href={`/app/s/${page.session_id}`} className="underline underline-offset-2 hover:text-text">
                    Open task
                  </Link>
                </>
              )}
            </p>
          )}
        </div>
        {page && (
          <a href={`/api/files/${page.id}?download`} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:bg-bg-subtle hover:text-text">
            <Download className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Download</span>
          </a>
        )}
      </header>
      {page ? <PageFrame id={page.id} title={title} fill className="min-h-0 flex-1" /> : <div className="flex-1 bg-surface" aria-busy="true" />}
    </div>
  );
}
