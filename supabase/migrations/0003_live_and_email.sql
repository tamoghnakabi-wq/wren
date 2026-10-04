-- Live browser preview per run, a crash counter for the tick watchdog, and
-- the user's email on profiles (the API role cannot read auth.users).

alter table public.profiles add column if not exists email text;

create or replace function public.wren_handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name, email)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1)), new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

create or replace function public.wren_sync_user_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end $$;

drop trigger if exists wren_on_auth_user_email on auth.users;
create trigger wren_on_auth_user_email
  after update of email on auth.users
  for each row execute function public.wren_sync_user_email();

update public.profiles p set email = u.email from auth.users u where u.id = p.id and p.email is null;

alter table public.runs add column if not exists crash_count integer not null default 0;

create table if not exists public.run_live (
  run_id uuid primary key references public.runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.sessions(id) on delete cascade,
  image text,
  url text,
  title text,
  updated_at timestamptz not null default now()
);
alter table public.run_live enable row level security;
revoke all on public.run_live from anon, authenticated;
grant select on public.run_live to authenticated;
create policy "own rows" on public.run_live for select to authenticated using (user_id = (select auth.uid()));
grant select, insert, update, delete on public.run_live to wren_api;
create policy "wren api" on public.run_live for all to wren_api using (true) with check (true);
alter publication supabase_realtime add table public.run_live;
