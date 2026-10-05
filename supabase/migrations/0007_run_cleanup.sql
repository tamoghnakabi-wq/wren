-- A finished cloud run's commands and browser tab are cleaned up after it ends; this flag stays
-- set until the VM confirms it, and the cron retries until then.
alter table public.runs add column if not exists cleanup_pending boolean not null default false;
create index if not exists runs_cleanup_pending on public.runs (ended_at) where cleanup_pending;
