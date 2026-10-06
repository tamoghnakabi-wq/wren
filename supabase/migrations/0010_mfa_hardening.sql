-- Two-step sign-in, hardened (re-audit of 0.1.10: W-86, W-87, W-89, W-90, W-94, W-97).
--
--  - A session counts only while Supabase Auth still has it (signed out / revoked = refused), for
--    every account, in the API (`wren_mfa_state().session_alive`) and in RLS (`wren_session_ok()`).
--  - Email codes go to the account's current address (`wren_mfa_state().user_email`, not the JWT's),
--    and each code is tied to the request that sent it (address, session, purpose; a newer request
--    supersedes older ones, like Supabase's own code does).
--  - The extra session that checking a code creates is ended in the same transaction that records
--    the check (`wren_end_otp_session`).
--  - Accounts with email codes on: Supabase Auth would change the password of any signed-in session
--    (email codes aren't an Auth factor), so a trigger only lets a password change commit through
--    the session Wren just checked (`mfa_password_permits`).
--  - Recovery codes never outlive the last authenticator app (they'd be a lone factor).

-- ---------------------------------------------------------------- state for the API

drop function if exists public.wren_mfa_state(uuid, uuid);
create function public.wren_mfa_state(p_user uuid, p_session uuid)
returns table (factors int, totp int, recovery_codes boolean, email boolean, email_verified_at timestamptz, user_email text, session_alive boolean)
language sql stable security definer set search_path = '' as $$
  select
    (select count(*)::int from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified'),
    (select count(*)::int from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified' and f.factor_type = 'totp'),
    exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified' and f.factor_type::text = 'recovery_code'),
    exists (select 1 from public.mfa_email e where e.user_id = p_user),
    (select c.email_verified_at from public.mfa_session_checks c
       join auth.sessions s on s.id = c.session_id and s.user_id = c.user_id
      where c.session_id = p_session and c.user_id = p_user),
    (select u.email::text from auth.users u where u.id = p_user),
    exists (select 1 from auth.sessions s
             where s.id = p_session and s.user_id = p_user and (s.not_after is null or s.not_after > now()))
$$;
revoke all on function public.wren_mfa_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.wren_mfa_state(uuid, uuid) to wren_api;

-- ---------------------------------------------------------------- the rule for RLS

create or replace function public.wren_session_ok()
returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when auth.uid() is null then false
    -- A token outlives its session (sign-out only revokes the refresh token): require the session.
    when not exists (select 1 from auth.sessions s
                      where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid and s.user_id = auth.uid()
                        and (s.not_after is null or s.not_after > now())) then false
    when exists (select 1 from public.mfa_email e where e.user_id = auth.uid()) then exists (
      select 1 from public.mfa_session_checks c
       where c.user_id = auth.uid() and c.session_id = nullif(auth.jwt() ->> 'session_id', '')::uuid)
    when exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
      then coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    else true
  end
$$;
revoke all on function public.wren_session_ok() from public, anon;
grant execute on function public.wren_session_ok() to authenticated;

-- ---------------------------------------------------------------- email code requests

-- The address the code went to, and when a newer request (or a failed send) made this one unusable.
alter table public.mfa_email_requests add column if not exists email text;
alter table public.mfa_email_requests add column if not exists superseded_at timestamptz;

-- Checking a code signs the user in once more (Supabase's verifyOtp): end that session. Only a
-- session of this user, minutes old, made by an email code alone.
create or replace function public.wren_end_otp_session(p_user uuid, p_session uuid)
returns boolean
language sql security definer set search_path = '' as $$
  with gone as (
    delete from auth.sessions s
     where s.id = p_session and s.user_id = p_user and s.created_at > now() - interval '15 minutes'
       and exists (select 1 from auth.mfa_amr_claims a where a.session_id = s.id and a.authentication_method = 'otp')
       and not exists (select 1 from auth.mfa_amr_claims a where a.session_id = s.id and a.authentication_method <> 'otp')
    returning 1)
  select exists (select 1 from gone)
$$;
revoke all on function public.wren_end_otp_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.wren_end_otp_session(uuid, uuid) to wren_api;

-- ---------------------------------------------------------------- password changes

-- Issued by the API right before it changes the password through Supabase Auth for a session that
-- passed the checks (POST /api/account/password); used up by the trigger below.
create table if not exists public.mfa_password_permits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  expires_at timestamptz not null default now() + interval '2 minutes'
);
alter table public.mfa_password_permits enable row level security;
revoke all on public.mfa_password_permits from anon, authenticated;
grant select, insert, update, delete on public.mfa_password_permits to wren_api;
drop policy if exists "wren api" on public.mfa_password_permits;
create policy "wren api" on public.mfa_password_permits for all to wren_api using (true) with check (true);

-- Runs when the transaction that changed the password commits. Supabase Auth signs out every other
-- session of the user in that same transaction, so the session a permit was issued for is still
-- there only if the change came through that session (an attacker's session would have signed it
-- out; the Admin API signs out all of them).
create or replace function public.wren_check_password_change()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  if not exists (select 1 from public.mfa_email e where e.user_id = new.id) then
    return null;
  end if;
  delete from public.mfa_password_permits p
   where p.user_id = new.id and p.expires_at > clock_timestamp()
     and exists (select 1 from auth.sessions s where s.id = p.session_id and s.user_id = new.id);
  get diagnostics n = row_count;
  if n = 0 then
    raise exception 'Email codes are on for this account: change the password in Wren, after an email code.'
      using errcode = '42501';
  end if;
  return null;
end $$;
revoke all on function public.wren_check_password_change() from public, anon, authenticated;

drop trigger if exists wren_on_auth_password_change on auth.users;
create constraint trigger wren_on_auth_password_change
  after update of encrypted_password on auth.users
  deferrable initially deferred
  for each row when (old.encrypted_password is distinct from new.encrypted_password)
  execute function public.wren_check_password_change();

-- ---------------------------------------------------------------- recovery codes

-- When an authenticator app is removed and no other one is left, remove the recovery codes too.
-- The user row lock serializes two removals at once (each would otherwise still see the other's app).
create or replace function public.wren_drop_lone_recovery_codes()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from auth.users u where u.id = old.user_id for update;
  if not exists (select 1 from auth.mfa_factors f
                  where f.user_id = old.user_id and f.status = 'verified' and f.factor_type::text <> 'recovery_code') then
    delete from auth.mfa_factors f where f.user_id = old.user_id and f.factor_type::text = 'recovery_code';
  end if;
  return null;
end $$;
revoke all on function public.wren_drop_lone_recovery_codes() from public, anon, authenticated;

drop trigger if exists wren_on_mfa_factor_removed on auth.mfa_factors;
create trigger wren_on_mfa_factor_removed
  after delete on auth.mfa_factors
  for each row when (old.factor_type::text <> 'recovery_code')
  execute function public.wren_drop_lone_recovery_codes();

-- Accounts already left with only recovery codes.
delete from auth.mfa_factors r
 where r.factor_type::text = 'recovery_code'
   and not exists (select 1 from auth.mfa_factors f
                    where f.user_id = r.user_id and f.status = 'verified' and f.factor_type::text <> 'recovery_code');

-- ---------------------------------------------------------------- housekeeping

create or replace function public.wren_mfa_cleanup()
returns void
language sql security definer set search_path = '' as $$
  delete from public.mfa_email_requests where sent_at < now() - interval '1 day';
  delete from public.mfa_session_checks c where not exists (select 1 from auth.sessions s where s.id = c.session_id);
  delete from public.mfa_password_permits where expires_at < now() - interval '1 hour';
$$;
revoke all on function public.wren_mfa_cleanup() from public, anon, authenticated;
grant execute on function public.wren_mfa_cleanup() to wren_api;
