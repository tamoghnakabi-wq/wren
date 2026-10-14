import { HttpError } from '@/lib/auth';
import { safeEqual } from '@/lib/crypto';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { json, route } from '@/lib/http';
import { notifyUser } from '@/lib/notify';
import { runCleanups } from '@/lib/cleanup';
import { endOrphanedRuns, revokeUnclaimedDevices } from '@/lib/devices';
import { cleanUpCloudRun, endRemovedAgentRuns, kickRun, kickTick, startTask } from '@/lib/runs';
import { nextRunAfter } from '@/lib/schedules';

// Called every minute by pg_cron (Supabase) with the cron secret:
//  1. re-kick cloud runs whose tick died (lease expired) or whose retry is due
//  2. start due scheduled tasks
//  3. expire stale approvals and tell the user
//  4. unlink computers that never checked in with the sign-in they were handed (W-151), end the tasks
//     of computers that were unlinked (W-147) and what removed agents left unfinished (W-163)
//  5. finish cleaning up ended cloud runs whose commands weren't confirmed stopped
//  6. retry deletions of cloud computers and stored files that didn't go through (W-157)
// The whole call answers by DEADLINE_MS (maxDuration is 60): each stage, its database work included, is
// waited for only until then, the stages that are mostly database work come before the provider calls
// (computers, files), and none starts new work once the time is up. A stage not reached is named in
// `skipped`, one still going at the deadline in `late` (what it already started may still finish; all of
// it is scoped to its own task, computer or file and safe to repeat), and the next minute carries on.
export const maxDuration = 60;
const DEADLINE_MS = 45_000;

function authorized(req: Request) {
  const h = req.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') && safeEqual(h.slice(7), env.cronSecret);
}

export const POST = route(async (req) => {
  if (!authorized(req)) throw new HttpError(401, 'Forbidden', 'forbidden');
  const until = Date.now() + DEADLINE_MS;
  const left = () => until - Date.now();
  const sql = db();
  const report = { kicked: 0, scheduled: 0, expired: 0, cleaned: 0, orphaned: 0, unclaimed: 0, deleted: 0, removed: 0, errors: [] as string[], skipped: [] as string[], late: [] as string[] };
  /** Wait for `work` at most `ms`, and never past the deadline: false if it was still going. */
  const inTime = async (work: Promise<unknown>, ms = Infinity): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const out = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), Math.max(0, Math.min(ms, left())))));
    try {
      return await Promise.race([work.then(() => true), out]);
    } finally {
      clearTimeout(timer);
    }
  };
  /** Run a stage if there is time left for it, waiting for it only until the deadline. */
  const stage = async (name: string, run: () => Promise<void>, ms?: number) => {
    if (left() <= 0) return void report.skipped.push(name);
    const work = run().catch((e: Error) => void report.errors.push(`${name}: ${e.message}`));
    if (!(await inTime(work, ms))) report.late.push(name);
  };
  /** Whether new work may still start (checked after a wait, before starting more). */
  const open = () => left() > 0;

  await stage('kick', async () => {
    const stale = await sql`
      select id from public.runs
      where runtime = 'cloud' and status in ('queued', 'running')
        and (lease_until is null or lease_until < now() - interval '20 seconds')
        and (wake_at is null or wake_at <= now())
        and updated_at < now() - interval '45 seconds'
      order by updated_at limit 20`;
    if (!open()) return;
    // A run that was just created is kicked by the API; only old ones need help. (Each kick gives up after 15 s.)
    report.kicked = stale.length;
    await Promise.allSettled(stale.map((r) => kickTick(r.id)));
  });

  await stage('schedules', async () => {
    // Claim due schedules by moving them to their next occurrence first, so an
    // interrupted invocation can at worst skip one occurrence, never stall a schedule.
    const due = await sql.begin(async (tx) => {
      const rows = await tx`select * from public.schedules where enabled and next_run_at <= now() order by next_run_at limit 10 for update skip locked`;
      for (const s of rows) await tx`update public.schedules set next_run_at = ${nextRunAfter(s.cron, s.timezone, new Date(s.next_run_at))} where id = ${s.id}`;
      return rows;
    });
    // Claimed, so started even past the deadline: not starting them would skip these occurrences.
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
  });

  await stage('approvals', async () => {
    const expired = await sql`
      update public.approvals set status = 'expired' where status = 'pending' and expires_at < now()
      returning run_id, session_id, user_id, title`;
    report.expired = expired.length;
    // Woken even past the deadline: no later call would find these runs again.
    await Promise.allSettled(
      expired.map(async (a) => {
        const [run] = await sql`update public.runs set status = 'queued' where id = ${a.run_id} and status = 'waiting' returning id`;
        if (run) await kickRun(a.run_id);
      }),
    );
  });

  await stage('unclaimed', async () => {
    report.unclaimed = await revokeUnclaimedDevices(until);
  });
  await stage('orphaned', async () => {
    report.orphaned = await endOrphanedRuns(undefined, until).catch((e: Error & { ended?: number }) => (report.errors.push(`orphaned: ${e.message}`), e.ended ?? 0));
  });
  await stage('removed', async () => {
    report.removed = await endRemovedAgentRuns(until);
  });

  // At most 15 s here, so the deletions below still get their turn.
  await stage(
    'cleanup',
    async () => {
      const unclean = await sql`
        select id, agent_id from public.runs
        where cleanup_pending and runtime = 'cloud' and ended_at < now() - interval '30 seconds'
        order by ended_at limit 10`;
      if (!open()) return;
      await Promise.allSettled(unclean.map(async (r) => (await cleanUpCloudRun(r.agent_id, r.id)) && report.cleaned++));
    },
    15_000,
  );

  // Each deletion takes at most 15 s and starts only if it can end before the deadline.
  await stage('deletions', async () => {
    report.deleted = await runCleanups(10, Math.min(35_000, left()));
  });

  await stage('housekeeping', async () => {
    await sql`delete from public.device_pairings where expires_at < now() - interval '1 day'`;
    await sql`select public.wren_mfa_cleanup()`;
  });
  return json(report);
});
