-- Coordinates stopping an agent's cloud computers with runs starting on them. The tick that stops
-- the computers decides (no cloud run of the agent active) and records a token here under a lock
-- on the agent's row; a tick that starts while the token is set waits for it to clear instead of
-- using a computer that is shutting down. Server-only: no browser access.
create table if not exists public.agent_computers (
  agent_id uuid primary key references public.agents(id) on delete cascade,
  stopping uuid,
  stopping_since timestamptz
);
alter table public.agent_computers enable row level security;
revoke all on public.agent_computers from anon, authenticated;
grant select, insert, update, delete on public.agent_computers to wren_api;
create policy "wren api" on public.agent_computers for all to wren_api using (true) with check (true);
