-- The app also reads these live; without them, server-side changes (auto-detected
-- time zone, new connections, schedule runs, usage) only appear after a reload.
alter publication supabase_realtime add table
  public.profiles, public.connections, public.schedules, public.usage_records;
