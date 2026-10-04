import { listModels } from '@wren/core';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { json, notFound, route, uuid } from '@/lib/http';
import { connectionSecret } from '@/lib/models';
import { probeMcp } from '@/lib/mcp';

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const rows = await db()`delete from public.connections where id = ${id} and user_id = ${user.id} returning id`;
  if (!rows.length) notFound('Connection not found.');
  return json({ ok: true });
});

/** Re-test a stored connection. */
export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const sql = db();
  const [c] = await sql`select * from public.connections where id = ${id} and user_id = ${user.id}`;
  if (!c) notFound('Connection not found.');
  const s = await connectionSecret(user.id, c.provider, id);
  let error: string | null = null;
  try {
    if (c.provider === 'github') {
      const res = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${s?.secret}`, 'user-agent': 'wren-agent' } });
      if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    } else if (c.provider === 'mcp') {
      await probeMcp(c.config.url, s?.secret);
    } else {
      await listModels(c.provider, s?.secret ?? '');
    }
  } catch (e) {
    error = (e as Error).message;
  }
  await sql`update public.connections set status = ${error ? 'error' : 'active'}, last_error = ${error}, last_checked_at = now() where id = ${id}`;
  return json({ ok: !error, error });
});
