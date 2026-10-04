-- Every minute, call Wren's scheduler/watchdog endpoint. The bearer secret is
-- read from Supabase Vault (secret name: wren_cron_secret), set out of band.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('wren-tick') where exists (select 1 from cron.job where jobname = 'wren-tick');
select cron.schedule(
  'wren-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://wren-agents.vercel.app/api/internal/cron',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'wren_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
