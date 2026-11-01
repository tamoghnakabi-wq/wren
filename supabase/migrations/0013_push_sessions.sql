-- W-199: a browser's push subscription belongs to the sign-in (auth session) that registered it,
-- and is pushed to only while that sign-in could still read the account: the session still exists
-- and hasn't expired, and has finished two-step sign-in by the same rule as `wren_session_ok()`.
-- A browser that signed out, or whose session ended or was revoked, gets nothing more, even if
-- its own clean-up (removing the subscription at sign-out) never ran.
--
-- Rows from before this have no session and get nothing until the browser registers again, which
-- the app does on every visit once notifications are allowed (`PushPrompt`).

alter table public.push_subscriptions add column if not exists session_id uuid;

create or replace function public.wren_push_targets(p_user uuid)
returns table (id uuid, endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.endpoint, p.p256dh, p.auth
    from public.push_subscriptions p
    join auth.sessions s on s.id = p.session_id and s.user_id = p.user_id
   where p.user_id = p_user
     and (s.not_after is null or s.not_after > now())
     and case
       when exists (select 1 from public.mfa_email e where e.user_id = p_user) then exists (
         select 1 from public.mfa_session_checks c where c.user_id = p_user and c.session_id = s.id)
       when exists (select 1 from auth.mfa_factors f where f.user_id = p_user and f.status = 'verified')
         then coalesce(s.aal::text, '') = 'aal2'
       else true
     end
$$;
revoke all on function public.wren_push_targets(uuid) from public, anon, authenticated;
grant execute on function public.wren_push_targets(uuid) to wren_api;
