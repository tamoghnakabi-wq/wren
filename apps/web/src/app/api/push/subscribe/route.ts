import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { body, json, route } from '@/lib/http';
import { isPushServiceEndpoint } from '@/lib/notify';

const Sub = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) });

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const s = await body(req, Sub);
  if (!isPushServiceEndpoint(s.endpoint)) return json({ error: 'That isn’t a supported browser push service.' }, 400);
  // Another account can only take over an endpoint from the same browser subscription (same keys),
  // e.g. after signing out and in as someone else on that browser.
  const rows = await db()`
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    values (${user.id}, ${s.endpoint}, ${s.keys.p256dh}, ${s.keys.auth}, ${req.headers.get('user-agent')?.slice(0, 300) ?? null})
    on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent
    where push_subscriptions.user_id = excluded.user_id or (push_subscriptions.p256dh = excluded.p256dh and push_subscriptions.auth = excluded.auth)
    returning id`;
  if (!rows.length) return json({ error: 'This push subscription belongs to another account.' }, 409);
  return json({ ok: true });
});

export const DELETE = route(async (req) => {
  const user = await requireUser(req);
  const { endpoint } = await body(req, z.object({ endpoint: z.string().max(1000) }));
  await db()`delete from public.push_subscriptions where user_id = ${user.id} and endpoint = ${endpoint}`;
  return json({ ok: true });
});
