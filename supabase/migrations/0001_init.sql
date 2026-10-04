-- Wren agent platform: core schema.
--
-- Lives in the `public` schema of a shared Supabase project. Browsers read their
-- own rows through RLS (and Realtime postgres_changes); every write goes through
-- the Wren API, which connects as the `wren_api` login role (created separately,
-- outside version control, from a SCRAM verifier).

create extension if not exists pgcrypto;

create or replace function public.wren_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  timezone text not null default 'UTC',
  settings jsonb not null default '{}'::jsonb,
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.wren_handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger wren_on_auth_user_created
  after insert on auth.users
  for each row execute function public.wren_handle_new_user();

-- ---------------------------------------------------------------- devices
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  platform text not null,
  arch text,
  app_version text,
  capabilities jsonb not null default '{}'::jsonb,
  policy jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index devices_user_idx on public.devices (user_id);

-- Server-only: hashed device bearer token and the secret Realtime channel key.
create table public.device_secrets (
  device_id uuid primary key references public.devices(id) on delete cascade,
  token_hash text not null unique,
  channel_key text not null
);

-- Device-code style pairing (desktop app <-> signed-in web session).
create table public.device_pairings (
  id uuid primary key default gen_random_uuid(),
  user_code text not null unique,
  poll_secret_hash text not null,
  device_name text not null,
  platform text not null,
  arch text,
  app_version text,
  user_id uuid references auth.users(id) on delete cascade,
  device_id uuid references public.devices(id) on delete cascade,
  approved_at timestamptz,
  delivered_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- connections
create table public.connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('model', 'service')),
  provider text not null,
  label text not null,
  config jsonb not null default '{}'::jsonb,
  secret_hint text,
  status text not null default 'active' check (status in ('active', 'error', 'disabled')),
  last_error text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index connections_user_idx on public.connections (user_id);

-- Server-only: AES-256-GCM ciphertext of the connection's secret.
create table public.connection_secrets (
  connection_id uuid primary key references public.connections(id) on delete cascade,
  ciphertext text not null
);

-- ---------------------------------------------------------------- agents
create table public.agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  icon text not null default 'sparkles',
  color text not null default 'violet',
  instructions text not null default '' check (char_length(instructions) <= 20000),
  model jsonb not null default '{}'::jsonb,
  runtime text not null default 'cloud' check (runtime in ('cloud', 'desktop')),
  device_id uuid references public.devices(id) on delete set null,
  tools jsonb not null default '{}'::jsonb,
  autonomy text not null default 'balanced' check (autonomy in ('careful', 'balanced', 'autonomous')),
  memory_enabled boolean not null default true,
  archived_at timestamptz,
  last_active_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index agents_user_idx on public.agents (user_id);

create table public.agent_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  content text not null check (char_length(content) <= 2000),
  created_at timestamptz not null default now()
);
create index agent_memories_agent_idx on public.agent_memories (agent_id, created_at);

-- ---------------------------------------------------------------- sessions / runs / events
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  title text not null default 'New task',
  status text not null default 'idle'
    check (status in ('idle', 'queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled')),
  runtime text not null default 'cloud' check (runtime in ('cloud', 'desktop')),
  device_id uuid references public.devices(id) on delete set null,
  last_event_at timestamptz not null default now(),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sessions_user_idx on public.sessions (user_id, last_event_at desc);
create index sessions_agent_idx on public.sessions (agent_id, last_event_at desc);

create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  prompt text not null check (char_length(prompt) between 1 and 8000),
  cron text not null,
  timezone text not null default 'UTC',
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_session_id uuid references public.sessions(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index schedules_due_idx on public.schedules (next_run_at) where enabled;

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled')),
  runtime text not null check (runtime in ('cloud', 'desktop')),
  device_id uuid references public.devices(id) on delete set null,
  trigger text not null default 'user' check (trigger in ('user', 'schedule', 'retry')),
  schedule_id uuid references public.schedules(id) on delete set null,
  model jsonb not null default '{}'::jsonb,
  step integer not null default 0,
  max_steps integer not null default 80,
  lease_id uuid,
  lease_until timestamptz,
  wake_at timestamptz,
  cancel_requested boolean not null default false,
  pause_requested boolean not null default false,
  error text,
  result text,
  usage jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index runs_session_idx on public.runs (session_id, created_at desc);
create index runs_active_idx on public.runs (status, lease_until) where status in ('queued', 'running');
create index runs_device_idx on public.runs (device_id, status) where runtime = 'desktop';

create table public.events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  run_id uuid references public.runs(id) on delete cascade,
  type text not null,
  status text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index events_session_idx on public.events (session_id, seq);
create index events_run_idx on public.events (run_id, seq);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  run_id uuid not null references public.runs(id) on delete cascade,
  event_id uuid references public.events(id) on delete set null,
  tool text not null,
  title text not null,
  detail jsonb not null default '{}'::jsonb,
  risk text not null default 'medium' check (risk in ('low', 'medium', 'high', 'critical')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  decided_at timestamptz,
  decided_via text,
  note text,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now()
);
create index approvals_user_pending_idx on public.approvals (user_id, created_at desc) where status = 'pending';
create index approvals_run_idx on public.approvals (run_id);

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid references public.agents(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete set null,
  run_id uuid references public.runs(id) on delete set null,
  name text not null,
  mime text not null default 'application/octet-stream',
  size bigint not null default 0,
  kind text not null default 'file' check (kind in ('file', 'screenshot', 'upload')),
  blob_path text not null,
  source text not null default 'cloud' check (source in ('cloud', 'desktop', 'user')),
  created_at timestamptz not null default now()
);
create index artifacts_user_idx on public.artifacts (user_id, created_at desc);
create index artifacts_session_idx on public.artifacts (session_id, created_at desc);

create table public.usage_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid references public.agents(id) on delete set null,
  run_id uuid references public.runs(id) on delete set null,
  source text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cached_tokens integer not null default 0,
  created_at timestamptz not null default now()
);
create index usage_records_user_idx on public.usage_records (user_id, created_at desc);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  url text,
  session_id uuid references public.sessions(id) on delete cascade,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

-- Server-only: Web Push subscriptions.
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- ---------------------------------------------------------------- updated_at triggers
create trigger wren_touch before update on public.profiles for each row execute function public.wren_touch();
create trigger wren_touch before update on public.connections for each row execute function public.wren_touch();
create trigger wren_touch before update on public.agents for each row execute function public.wren_touch();
create trigger wren_touch before update on public.sessions for each row execute function public.wren_touch();
create trigger wren_touch before update on public.schedules for each row execute function public.wren_touch();
create trigger wren_touch before update on public.runs for each row execute function public.wren_touch();
create trigger wren_touch before update on public.events for each row execute function public.wren_touch();

-- ---------------------------------------------------------------- privileges + RLS
-- Browsers (role `authenticated`) may only SELECT their own rows from the
-- user-facing tables; everything else is revoked. `anon` gets nothing.
do $$
declare
  t text;
  user_tables text[] := array['profiles', 'devices', 'connections', 'agents', 'agent_memories', 'sessions',
    'schedules', 'runs', 'events', 'approvals', 'artifacts', 'usage_records', 'notifications'];
  hidden_tables text[] := array['device_secrets', 'device_pairings', 'connection_secrets', 'push_subscriptions'];
begin
  foreach t in array user_tables || hidden_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
  foreach t in array user_tables loop
    execute format('grant select on public.%I to authenticated', t);
    if t = 'profiles' then
      execute format('create policy "own rows" on public.%I for select to authenticated using (id = (select auth.uid()))', t);
    else
      execute format('create policy "own rows" on public.%I for select to authenticated using (user_id = (select auth.uid()))', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- realtime
alter publication supabase_realtime add table
  public.agents, public.sessions, public.runs, public.events, public.approvals,
  public.notifications, public.devices, public.artifacts;
