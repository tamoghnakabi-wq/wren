import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { revokeDevice } from '@/lib/devices';
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

/** Unlink a device: its token stops working immediately, and its unfinished tasks end. */
export const DELETE = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const [d] = await db()`select id from public.devices where id = ${id} and user_id = ${user.id}`;
  if (!d) notFound('Device not found.');
  await revokeDevice(id);
  return json({ ok: true });
});
