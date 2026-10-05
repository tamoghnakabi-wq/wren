-- At most one active run per session: concurrent "continue" requests can't start two.
create unique index if not exists runs_one_active_per_session on public.runs (session_id)
  where status in ('queued', 'running', 'waiting', 'paused');

-- Retryable model failures (429/5xx, cut streams) across ticks, so they can't retry forever.
alter table public.runs add column if not exists retry_count int not null default 0;
