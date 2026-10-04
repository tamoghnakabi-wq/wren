import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { json, notFound, route, uuid } from '@/lib/http';
import { startTask } from '@/lib/runs';

export const maxDuration = 60;

// "Run now" for a schedule.
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const sql = db();
  const [s] = await sql`select * from public.schedules where id = ${id} and user_id = ${user.id}`;
  if (!s) notFound('Schedule not found.');
  const r = await startTask({ userId: user.id, agentId: s.agent_id, text: s.prompt, trigger: 'schedule', scheduleId: s.id, scheduleName: s.name });
  await sql`update public.schedules set last_run_at = now(), last_session_id = ${r.sessionId} where id = ${id}`;
  return json(r, 201);
});
