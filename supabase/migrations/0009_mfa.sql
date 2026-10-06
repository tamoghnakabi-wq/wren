-- Two-step sign-in (MFA).
--
-- Authenticator apps (TOTP) and recovery codes are Supabase Auth MFA factors: verifying one raises
-- the session to `aal2` in its JWT. Supabase has no email MFA factor, so email codes are Wren's:
-- the code itself is a Supabase Auth email OTP (Supabase generates, sends, expires and checks it);
-- Wren records which session passed one (`mfa_session_checks`). A user who turned on email codes
-- keeps needing one until they turn them off from a verified session; an authenticator someone
-- else added straight through the Auth API doesn't stand in for them.
--
-- `wren_session_ok()` is the one rule, used by every browser-readable table (restrictive policies)
-- and, through `wren_mfa_state()`, by the API:
--   - email codes on: this session passed an email code;
--   - else any verified Auth factor: the JWT is `aal2`;
--   - else: nothing more is needed.

create table if not exists public.mfa_email (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled_at timestamptz not null default now()
);

-- Each email code Wren asked Supabase to send: for rate limits, for tying a code to the session
-- that asked for it, and for counting wrong guesses.
create table if not exists public.mfa_email_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  purpose text not null check (purpose in ('sign_in', 'step_up', 'enable')),
  sent_at timestamptz not null default now(),
  attempts int not null default 0,
  used_at timestamptz
);
create index if not exists mfa_email_requests_user on public.mfa_email_requests (user_id, sent_at desc);

-- Sessions that passed an email code, and when (also the "recently verified" time for step-up).
create table if not exists public.mfa_session_checks (
  session_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  email_verified_at timestamptz not null
);

do $$
declare
  t text;
begin
  foreach t in array array['mfa_email', 'mfa_email_requests', 'mfa_session_checks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to wren_api', t);
    execute format('drop policy if exists "wren api" on public.%I', t);
    execute format('create policy "wren api" on public.%I for all to wren_api using (true) with check (true)', t);
  end loop;
end $$;

-- The MFA facts for one user and session. Server only (the API passes the user and session from a
-- verified JWT); never callable by browsers, since it takes any user id.
create or replace function public.wren_mfa_state(p_user uuid, p_session uuid)
returns table (factors int, totp int, recovery_codes boolean, email boolean, email_verified_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*)::int from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified'),
    (select count(*)::int from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified' and f.factor_type = 'totp'),
    exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified' and f.factor_type::text = 'recovery_code'),
    exists (select 1 from public.mfa_email e where e.user_id = p_user),
    (select c.email_verified_at from public.mfa_session_checks c
       join auth.sessions s on s.id = c.session_id and s.user_id = c.user_id
      where c.session_id = p_session and c.user_id = p_user)
$$;
revoke all on function public.wren_mfa_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.wren_mfa_state(uuid, uuid) to wren_api;

-- Whether the caller's session (its JWT) passes the user's MFA. Only ever about the caller.
create or replace function public.wren_session_ok()
returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when auth.uid() is null then false
    when exists (select 1 from public.mfa_email e where e.user_id = auth.uid()) then exists (
      select 1 from public.mfa_session_checks c
        join auth.sessions s on s.id = c.session_id and s.user_id = c.user_id
       where c.user_id = auth.uid() and c.session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid)
    when exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
      then coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    else true
  end
$$;
revoke all on function public.wren_session_ok() from public, anon;
grant execute on function public.wren_session_ok() to authenticated;

-- Housekeeping for the cron: old code requests, and records of sessions that have ended.
create or replace function public.wren_mfa_cleanup()
returns void
language sql security definer set search_path = '' as $$
  delete from public.mfa_email_requests where sent_at < now() - interval '1 day';
  delete from public.mfa_session_checks c where not exists (select 1 from auth.sessions s where s.id = c.session_id);
$$;
revoke all on function public.wren_mfa_cleanup() from public, anon, authenticated;
grant execute on function public.wren_mfa_cleanup() to wren_api;

-- Every table browsers read: rows are visible only to a session that passes MFA. Restrictive, so
-- it is ANDed with the existing "own rows" policies (Realtime applies it too).
do $$
declare
  t text;
begin
  foreach t in array array['profiles', 'devices', 'connections', 'agents', 'agent_memories', 'sessions', 'schedules',
    'runs', 'events', 'approvals', 'artifacts', 'usage_records', 'notifications', 'run_live'] loop
    execute format('drop policy if exists "mfa" on public.%I', t);
    execute format('create policy "mfa" on public.%I as restrictive for select to authenticated using ((select public.wren_session_ok()))', t);
  end loop;
end $$;
