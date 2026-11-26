import { HttpError, requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { body, json, notFound, route, uuid } from '@/lib/http';
import { knownTimeZone, nextRun, SchedulePatchSchema, validateCron, validateRunAt } from '@/lib/schedules';

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const b = await body(req, SchedulePatchSchema);
  const sql = db();
  const [cur] = await sql`select * from public.schedules where id = ${id} and user_id = ${user.id}`;
  if (!cur) notFound('Schedule not found.');
  if (b.agentId) {
    const [a] = await sql`select id from public.agents where id = ${b.agentId} and user_id = ${user.id} and archived_at is null`;
    if (!a) notFound('Agent not found.');
  }
  // A new repeat makes it repeat, a new time makes it run once; otherwise it stays as it was.
  const runAt: Date | null = b.cron ? null : b.runAt ? new Date(b.runAt) : cur.run_at ? new Date(cur.run_at) : null;
  const next = {
    name: b.name ?? cur.name, prompt: b.prompt ?? cur.prompt, cron: runAt ? null : (b.cron ?? cur.cron) as string, timezone: b.timezone ?? cur.timezone,
    enabled: b.enabled ?? cur.enabled, agent_id: b.agentId ?? cur.agent_id,
  };
  if (runAt) {
    if (!knownTimeZone(next.timezone)) throw new HttpError(400, 'Unknown time zone.', 'invalid');
    // A time that has passed (a one-off that couldn't start) has to be set again to switch it back on.
    if (next.enabled) validateRunAt(runAt);
  } else validateCron(next.cron!, next.timezone);
  const [s] = await sql`
    update public.schedules set name = ${next.name}, prompt = ${next.prompt}, cron = ${next.cron}, run_at = ${runAt}, timezone = ${next.timezone},
      enabled = ${next.enabled}, agent_id = ${next.agent_id},
      next_run_at = ${next.enabled ? (runAt ?? nextRun(next.cron!, next.timezone)) : null}
    where id = ${id} returning *`;
  return json(s);
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  await db()`delete from public.schedules where id = ${id} and user_id = ${user.id}`;
  return json({ ok: true });
});
