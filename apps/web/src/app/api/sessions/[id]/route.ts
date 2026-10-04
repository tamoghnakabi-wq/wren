import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { body, json, notFound, route, uuid } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const b = await body(req, z.object({ title: z.string().trim().min(1).max(120).optional(), archived: z.boolean().optional() }));
  const sql = db();
  const [s] = await sql`
    update public.sessions set
      title = coalesce(${b.title ?? null}, title),
      archived_at = case when ${b.archived ?? null}::boolean is null then archived_at when ${b.archived ?? false} then now() else null end
    where id = ${id} and user_id = ${user.id} returning id, title, archived_at`;
  if (!s) notFound('Task not found.');
  return json(s);
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const sql = db();
  const active = await sql`select 1 from public.runs where session_id = ${id} and status in ('queued', 'running', 'waiting') limit 1`;
  if (active.length) return json({ error: 'Stop the task before deleting it.' }, 409);
  await sql`delete from public.sessions where id = ${id} and user_id = ${user.id}`;
  return json({ ok: true });
});
