import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { body, json, notFound, route, uuid } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const b = await body(req, z.object({ name: z.string().trim().min(1).max(60) }));
  const [d] = await db()`update public.devices set name = ${b.name} where id = ${id} and user_id = ${user.id} returning id, name`;
  if (!d) notFound('Device not found.');
  return json(d);
});

/** Unlink a device: its token stops working immediately. */
export const DELETE = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const sql = db();
  const [d] = await sql`update public.devices set revoked_at = now() where id = ${id} and user_id = ${user.id} returning id`;
  if (!d) notFound('Device not found.');
  await sql`delete from public.device_secrets where device_id = ${id}`;
  await sql`update public.runs set cancel_requested = true where device_id = ${id} and status in ('queued', 'running', 'waiting', 'paused')`;
  return json({ ok: true });
});
