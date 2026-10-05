import { HttpError } from '@/lib/auth';
import { safeEqual } from '@/lib/crypto';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { json, route } from '@/lib/http';
import { notifyUser } from '@/lib/notify';
import { cleanUpCloudRun, kickRun, kickTick, startTask } from '@/lib/runs';
import { nextRun } from '@/lib/schedules';

// Called every minute by pg_cron (Supabase) with the cron secret:
//  1. re-kick cloud runs whose tick died (lease expired) or whose retry is due
//  2. start due scheduled tasks
//  3. expire stale approvals and tell the user
//  4. finish cleaning up ended cloud runs whose commands weren't confirmed stopped
export const maxDuration = 60;

function authorized(req: Request) {
  const h = req.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') && safeEqual(h.slice(7), env.cronSecret);
}

export const POST = route(async (req) => {
  if (!authorized(req)) throw new HttpError(401, 'Forbidden', 'forbidden');
  const sql = db();
  const report = { kicked: 0, scheduled: 0, expired: 0, cleaned: 0, errors: [] as string[] };

  const stale = await sql`
    select id from public.runs
    where runtime = 'cloud' and status in ('queued', 'running')
      and (lease_until is null or lease_until < now() - interval '20 seconds')
      and (wake_at is null or wake_at <= now())
      and updated_at < now() - interval '45 seconds'
    order by updated_at limit 20`;
  // A run that was just created is kicked by the API; only old ones need help.
  await Promise.allSettled(stale.map((r) => kickTick(r.id)));
  report.kicked = stale.length;

  const unclean = await sql`
    select id, agent_id from public.runs
    where cleanup_pending and runtime = 'cloud' and ended_at < now() - interval '30 seconds'
    order by ended_at limit 10`;
  const cleaned = await Promise.allSettled(unclean.map((r) => cleanUpCloudRun(r.agent_id, r.id)));
  report.cleaned = cleaned.filter((c) => c.status === 'fulfilled' && c.value).length;

  // Claim due schedules by moving them to their next occurrence first, so an
  // interrupted invocation can at worst skip one occurrence, never stall a schedule.
  const due = await sql.begin(async (tx) => {
    const rows = await tx`select * from public.schedules where enabled and next_run_at <= now() order by next_run_at limit 10 for update skip locked`;
    for (const s of rows) await tx`update public.schedules set next_run_at = ${nextRun(s.cron, s.timezone)} where id = ${s.id}`;
    return rows;
  });
  await Promise.allSettled(
    due.map(async (s) => {
      try {
        const r = await startTask({ userId: s.user_id, agentId: s.agent_id, text: s.prompt, trigger: 'schedule', scheduleId: s.id, scheduleName: s.name });
        await sql`update public.schedules set last_run_at = now(), last_session_id = ${r.sessionId} where id = ${s.id}`;
        report.scheduled++;
      } catch (e) {
        const msg = (e as Error).message;
        report.errors.push(`${s.id}: ${msg}`);
        await notifyUser({ userId: s.user_id, kind: 'schedule_failed', title: `Scheduled task "${s.name}" didn't start`, body: msg, url: '/app/schedules' });
      }
    }),
  );

  const expired = await sql`
    update public.approvals set status = 'expired' where status = 'pending' and expires_at < now()
    returning run_id, session_id, user_id, title`;
  report.expired = expired.length;
  await Promise.allSettled(
    expired.map(async (a) => {
      const [run] = await sql`update public.runs set status = 'queued' where id = ${a.run_id} and status = 'waiting' returning id`;
      if (run) await kickRun(a.run_id);
    }),
  );

  await sql`delete from public.device_pairings where expires_at < now() - interval '1 day'`;
  return json(report);
});
