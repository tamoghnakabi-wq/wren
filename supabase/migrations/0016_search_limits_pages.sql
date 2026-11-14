-- Search, usage-limit pauses and visual replies (Wren 0.1.48).

-- Searching tasks (the ⌘K palette, POST /api/search): what was said in a task is found by its words, through
-- this one index. 'simple' keeps every word as written (no stemming, no stop words), so any language works the
-- same way; the explicit regconfig makes to_tsvector immutable, as an index expression must be. Only the first
-- 100,000 characters are indexed: to_tsvector fails on text whose words pass 1 MB, and an index expression that
-- fails would make saving that message fail. /api/search uses the same expression, or this index isn't used.
create index if not exists events_message_words on public.events
  using gin (to_tsvector('simple'::regconfig, left(coalesce(data->>'text', ''), 100000)))
  where type = 'message';

-- A run paused by a plan's usage limit wakes at the reset (the cron's `limits` stage looks these up).
create index if not exists runs_paused_wake on public.runs (wake_at) where status = 'paused' and wake_at is not null;

-- A page an agent made (task.show_page): shown in the task, in a sandboxed frame, through /api/pages/[id].
-- Its own kind, so an uploaded or shared .html file is never rendered that way.
alter table public.artifacts drop constraint if exists artifacts_kind_check;
alter table public.artifacts add constraint artifacts_kind_check check (kind in ('file', 'screenshot', 'upload', 'page'));
