-- Agents asking each other (task.ask_agent). The asked agent works on the question as a task of its own,
-- linked to the run that asked: `parent_ask_key` names the ask (the asking step's event id, or a hash of an
-- engine's question), so asking again after a crash finds the same task. Its run has trigger 'agent' and
-- works with at most the asking agent's autonomy (`autonomy_cap`).

alter table public.sessions
  add column parent_session_id uuid references public.sessions(id) on delete set null,
  add column parent_run_id uuid references public.runs(id) on delete set null,
  add column parent_ask_key text;

create unique index sessions_parent_ask on public.sessions (parent_run_id, parent_ask_key) where parent_run_id is not null;
create index sessions_parent_session on public.sessions (parent_session_id) where parent_session_id is not null;

alter table public.runs
  add column autonomy_cap text check (autonomy_cap in ('careful', 'balanced', 'autonomous'));

alter table public.runs drop constraint runs_trigger_check;
alter table public.runs add constraint runs_trigger_check check (trigger in ('user', 'schedule', 'retry', 'agent'));

-- The cron's look for asks whose answer the asker missed, and for asked tasks that ran too long.
create index events_awaiting_agent on public.events (run_id) where type = 'tool' and status = 'awaiting_agent';
create index runs_active_asks on public.runs (created_at) where trigger = 'agent' and status in ('queued', 'running', 'waiting', 'paused');
