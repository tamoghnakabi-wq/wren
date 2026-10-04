import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { json, route, uuid } from '@/lib/http';

export const DELETE = route<{ params: Promise<{ id: string; mid: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  const p = await ctx.params;
  await db()`delete from public.agent_memories where id = ${uuid.parse(p.mid)} and agent_id = ${uuid.parse(p.id)} and user_id = ${user.id}`;
  return json({ ok: true });
});
