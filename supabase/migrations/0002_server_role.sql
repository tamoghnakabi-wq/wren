-- Grants for the Wren API's login role. The role itself (`wren_api`, LOGIN,
-- NOINHERIT) is created out of band from a SCRAM verifier so no password ever
-- appears in version control.

grant usage on schema public to wren_api;

do $$
declare
  t text;
  tables text[] := array['profiles', 'devices', 'device_secrets', 'device_pairings', 'connections',
    'connection_secrets', 'agents', 'agent_memories', 'sessions', 'schedules', 'runs', 'events',
    'approvals', 'artifacts', 'usage_records', 'notifications', 'push_subscriptions'];
begin
  foreach t in array tables loop
    execute format('grant select, insert, update, delete on public.%I to wren_api', t);
    execute format('create policy "wren api" on public.%I for all to wren_api using (true) with check (true)', t);
  end loop;
end $$;

grant usage on all sequences in schema public to wren_api;

-- Lets the API nudge desktop devices over private Realtime broadcast topics.
grant usage on schema realtime to wren_api;
grant execute on function realtime.send(jsonb, text, text, boolean) to wren_api;

-- Account deletion without a service-role key: runs as the owner, callable only by the API.
create or replace function public.wren_delete_account(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from auth.users where id = p_user;
end $$;
revoke all on function public.wren_delete_account(uuid) from public, anon, authenticated;
grant execute on function public.wren_delete_account(uuid) to wren_api;

-- realtime.send() inserts into realtime.messages.
grant insert on realtime.messages to wren_api;
create policy "wren api broadcast" on realtime.messages for insert to wren_api with check (true);
