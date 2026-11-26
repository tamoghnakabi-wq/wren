-- One-off schedules (reminders), secrets an agent asked for, and tasks carried on with another agent (Wren 0.1.55).

-- A schedule either repeats (`cron`) or runs once (`run_at`), never both. A one-off one is deleted once it
-- has started its task (the task is the record); one that couldn't start stays, switched off, so the user
-- sees it. An agent can set one with the user's approval (task.schedule): `source_session_id` is the task
-- it was set in.
alter table public.schedules alter column cron drop not null;
alter table public.schedules add column if not exists run_at timestamptz;
alter table public.schedules add column if not exists source_session_id uuid references public.sessions(id) on delete set null;
alter table public.schedules drop constraint if exists schedules_when;
alter table public.schedules add constraint schedules_when check ((cron is null) <> (run_at is null));

-- A secret the user gave a task when its agent asked (task.request_secret): encrypted with WREN_SECRETS_KEY
-- (lib/crypto.ts), handed only to that task's commands as an environment variable of this name, blanked out of
-- what the task saves, and deleted after `expires_at` (24 hours) by the cron, or with the task. Server-only: no
-- browser access, as for connection_secrets.
create table if not exists public.task_secrets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  name text not null check (name ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  ciphertext text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (session_id, name)
);
create index if not exists task_secrets_expiry on public.task_secrets (expires_at);
alter table public.task_secrets enable row level security;
revoke all on public.task_secrets from anon, authenticated;
grant select, insert, update, delete on public.task_secrets to wren_api;
drop policy if exists "wren api" on public.task_secrets;
create policy "wren api" on public.task_secrets for all to wren_api using (true) with check (true);

-- A task carried on with another agent (the old one paused at a usage limit, say): the new task starts with
-- the old one's conversation in its context, and links back to it here.
alter table public.sessions add column if not exists handed_from uuid references public.sessions(id) on delete set null;
