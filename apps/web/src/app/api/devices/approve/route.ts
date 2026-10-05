import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { body, json, route } from '@/lib/http';

// Desktop pairing, step 2: the signed-in user confirms the code shown by the app.
export const POST = route(async (req) => {
  const user = await requireUser(req);
  const b = await body(req, z.object({ code: z.string().trim().toUpperCase().max(12), approve: z.boolean().default(true) }));
  const code = b.code.replace(/[^A-Z0-9]/g, '').replace(/^(.{4})/, '$1-');
  const sql = db();
  const [p] = await sql`select id, device_name, platform, expires_at, approved_at from public.device_pairings where user_code = ${code}`;
  if (!p || new Date(p.expires_at) < new Date()) return json({ error: 'That code is invalid or expired. Start linking again from the desktop app.' }, 404);
  if (p.approved_at) return json({ error: 'That code was already used.' }, 409);
  if (!b.approve) {
    await sql`update public.device_pairings set expires_at = now() where id = ${p.id}`;
    return json({ ok: true, approved: false });
  }
  const claimed = await sql`update public.device_pairings set user_id = ${user.id}, approved_at = now() where id = ${p.id} and approved_at is null and expires_at > now() returning id`;
  if (!claimed.length) return json({ error: 'That code was already used.' }, 409);
  return json({ ok: true, approved: true, device: { name: p.device_name, platform: p.platform } });
});

/** Look up a pending code (to show the device name before approving). */
export const GET = route(async (req) => {
  await requireUser(req);
  const raw = new URL(req.url).searchParams.get('code') ?? '';
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})/, '$1-');
  const [p] = await db()`select device_name, platform, expires_at, approved_at from public.device_pairings where user_code = ${code}`;
  if (!p || new Date(p.expires_at) < new Date() || p.approved_at) return json({ valid: false });
  return json({ valid: true, device: { name: p.device_name, platform: p.platform } });
});
