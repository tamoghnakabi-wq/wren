import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { body, json, notFound, route } from '@/lib/http';
import { insertSchedule, ScheduleSchema, validateCron, validateRunAt } from '@/lib/schedules';

// A new schedule: repeating (`cron`) or once (`runAt`).
export const POST = route(async (req) => {
  const user = await requireUser(req);
  const b = await body(req, ScheduleSchema);
  const runAt = b.runAt ? new Date(b.runAt) : null;
  if (runAt) validateRunAt(runAt);
  else validateCron(b.cron!, b.timezone);
  const [agent] = await db()`select id from public.agents where id = ${b.agentId} and user_id = ${user.id} and archived_at is null`;
  if (!agent) notFound('Agent not found.');
  const s = await insertSchedule({ userId: user.id, agentId: b.agentId, name: b.name, prompt: b.prompt, cron: runAt ? null : b.cron!, runAt, timezone: b.timezone, enabled: b.enabled });
  return json(s, 201);
});
