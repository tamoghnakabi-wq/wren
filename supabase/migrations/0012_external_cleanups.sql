-- Deletions outside the database (a removed agent's cloud computers and their snapshots, stored files)
-- that didn't go through at once. They are kept here, apart from the rows being deleted (no foreign
-- keys, so they outlive an account's deletion), and the cron retries them until they're confirmed
-- (re-audit of 0.1.24, W-157). Server-only: no browser access.
create table if not exists public.external_cleanups (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('sandbox', 'blob')),
  ref text not null,
  attempts int not null default 0,
  last_error text,
  next_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (kind, ref)
);
create index if not exists external_cleanups_due_idx on public.external_cleanups (next_at);
alter table public.external_cleanups enable row level security;
revoke all on public.external_cleanups from anon, authenticated;
grant select, insert, update, delete on public.external_cleanups to wren_api;
create policy "wren api" on public.external_cleanups for all to wren_api using (true) with check (true);

-- Finding computers that were handed a sign-in but never checked in (devices.ts revokeUnclaimedDevices).
create index if not exists devices_unclaimed_idx on public.devices (created_at) where revoked_at is null and last_seen_at = created_at;
