import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { body, json, route } from '@/lib/http';

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const b = await body(req, z.object({ ids: z.array(z.string().uuid()).max(200).optional(), all: z.boolean().optional() }));
  const sql = db();
  if (b.all) await sql`update public.notifications set read_at = now() where user_id = ${user.id} and read_at is null`;
  else if (b.ids?.length) await sql`update public.notifications set read_at = now() where user_id = ${user.id} and id = any(${b.ids}::uuid[])`;
  return json({ ok: true });
});
