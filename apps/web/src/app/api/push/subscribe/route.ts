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
  // e.g. after signing out and in as someone else on that browser. The row is tied to this sign-in:
  // pushes go to it only while the sign-in is live (W-199, `wren_push_targets`), and the app
  // registers again on each visit, which moves it to the browser's current sign-in.
  const rows = await db()`
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, session_id)
    values (${user.id}, ${s.endpoint}, ${s.keys.p256dh}, ${s.keys.auth}, ${req.headers.get('user-agent')?.slice(0, 300) ?? null}, ${user.sessionId ?? null})
    on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, session_id = excluded.session_id
    where push_subscriptions.user_id = excluded.user_id or (push_subscriptions.p256dh = excluded.p256dh and push_subscriptions.auth = excluded.auth)
    returning id`;
  if (!rows.length) return json({ error: 'This push subscription belongs to another account.' }, 409);
  return json({ ok: true });
});

// Sign-out calls this first. It only ever stops deliveries, so it also works for a sign-in that
// hasn't finished two-step sign-in (its "Sign out and use another account").
export const DELETE = route(async (req) => {
  const user = await requireUser(req, { mfa: 'skip' });
  const { endpoint } = await body(req, z.object({ endpoint: z.string().max(1000) }));
  await db()`delete from public.push_subscriptions where user_id = ${user.id} and endpoint = ${endpoint}`;
  return json({ ok: true });
});
