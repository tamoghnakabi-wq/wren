import { HttpError } from '@/lib/auth';
import { safeEqual } from '@/lib/crypto';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { json, route } from '@/lib/http';
import { notifyUser } from '@/lib/notify';
import { kickTick, startTask } from '@/lib/runs';
import { nextRun } from '@/lib/schedules';

// Called every minute by pg_cron (Supabase) with the cron secret:
//  1. re-kick cloud runs whose tick died (lease expired) or whose retry is due
//  2. start due scheduled tasks
//  3. expire stale approvals and tell the user
export const maxDuration = 60;

function authorized(req: Request) {
  const h = req.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') && safeEqual(h.slice(7), env.cronSecret);
}

export const POST = route(async (req) => {
  if (!authorized(req)) throw new HttpError(401, 'Forbidden', 'forbidden');
  const sql = db();
  const report = { kicked: 0, scheduled: 0, expired: 0, errors: [] as string[] };

  const stale = await sql`
    select id from public.runs
    where runtime = 'cloud' and status in ('queued', 'running')
      and (lease_until is null or lease_until < now() - interval '20 seconds')
      and (wake_at is null or wake_at <= now())
      and updated_at < now() - interval '45 seconds'
    order by updated_at limit 20`;
  // A run that was just created is kicked by the API; only old ones need help.
  for (const r of stale) {
    await kickTick(r.id);
    report.kicked++;
  }

  const due = await sql`
    update public.schedules set next_run_at = null
    where id in (select id from public.schedules where enabled and next_run_at <= now() order by next_run_at limit 10 for update skip locked)
    returning *`;
  for (const s of due) {
    try {
      const r = await startTask({ userId: s.user_id, agentId: s.agent_id, text: s.prompt, trigger: 'schedule', scheduleId: s.id, scheduleName: s.name });
      await sql`update public.schedules set last_run_at = now(), last_session_id = ${r.sessionId}, next_run_at = ${nextRun(s.cron, s.timezone)} where id = ${s.id}`;
      report.scheduled++;
    } catch (e) {
      const msg = (e as Error).message;
      report.errors.push(`${s.id}: ${msg}`);
      await sql`update public.schedules set next_run_at = ${nextRun(s.cron, s.timezone)} where id = ${s.id}`;
      await notifyUser({ userId: s.user_id, kind: 'schedule_failed', title: `Scheduled task "${s.name}" didn't start`, body: msg, url: '/app/schedules' });
    }
  }

  const expired = await sql`
    update public.approvals set status = 'expired' where status = 'pending' and expires_at < now()
    returning run_id, session_id, user_id, title`;
  for (const a of expired) {
    report.expired++;
    await sql`update public.runs set status = 'queued' where id = ${a.run_id} and status = 'waiting'`;
    const [run] = await sql`select runtime from public.runs where id = ${a.run_id}`;
    if (run?.runtime === 'cloud') await kickTick(a.run_id);
  }

  await sql`delete from public.device_pairings where expires_at < now() - interval '1 day'`;
  return json(report);
});
