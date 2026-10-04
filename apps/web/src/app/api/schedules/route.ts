import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { body, json, notFound, route } from '@/lib/http';
import { nextRun, ScheduleSchema, validateCron } from '@/lib/schedules';



export const POST = route(async (req) => {
  const user = await requireUser(req);
  const b = await body(req, ScheduleSchema);
  validateCron(b.cron, b.timezone);
  const sql = db();
  const [agent] = await sql`select id from public.agents where id = ${b.agentId} and user_id = ${user.id} and archived_at is null`;
  if (!agent) notFound('Agent not found.');
  const [n] = await sql`select count(*)::int as n from public.schedules where user_id = ${user.id}`;
  if (n.n >= 50) return json({ error: 'You can have up to 50 schedules.' }, 400);
  const [s] = await sql`
    insert into public.schedules (user_id, agent_id, name, prompt, cron, timezone, enabled, next_run_at)
    values (${user.id}, ${b.agentId}, ${b.name}, ${b.prompt}, ${b.cron}, ${b.timezone}, ${b.enabled}, ${b.enabled ? nextRun(b.cron, b.timezone) : null})
    returning *`;
  return json(s, 201);
});
