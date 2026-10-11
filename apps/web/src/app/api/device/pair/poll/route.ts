import { z } from 'zod';
import { keyedToken, randomToken, sha256 } from '@/lib/crypto';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { body, json, route } from '@/lib/http';

/** How long a delivered link can be fetched again by the desktop that polled for it (W-151). */
const REDELIVER_MS = 10 * 60_000;

// Desktop pairing, step 3: once the signed-in user approved the code, hand the device its long-lived
// token. The token is derived from this pairing and the desktop's poll secret, which only that desktop
// has, so if an answer is lost on the way (a timeout) it can poll again and get the same one for a few
// minutes; nobody else can. Delivery runs under the pairing's row lock, so two polls make one device.
export const POST = route(async (req) => {
  const b = await body(req, z.object({ pairId: z.string().uuid(), pollSecret: z.string().min(20).max(100) }));
  const token = keyedToken(`device-token:${b.pairId}:${b.pollSecret}`);
  const out = await db().begin(async (tx) => {
    const [p] = await tx`select * from public.device_pairings where id = ${b.pairId} and poll_secret_hash = ${sha256(b.pollSecret)} for update`;
    if (!p) return null;
    if (p.delivered_at) {
      if (!p.device_id || Date.now() - new Date(p.delivered_at).getTime() > REDELIVER_MS) return null;
      // The same answer again, while that device is still linked with this token.
      const [d] = await tx`
        select d.id, s.channel_key from public.devices d join public.device_secrets s on s.device_id = d.id
        where d.id = ${p.device_id} and d.revoked_at is null and s.token_hash = ${sha256(token)}`;
      return d ? { userId: p.user_id as string, deviceId: d.id as string, channelKey: d.channel_key as string } : null;
    }
    if (new Date(p.expires_at) < new Date()) return null;
    if (!p.approved_at || !p.user_id) return 'pending' as const;
    const channelKey = randomToken(24);
    const [d] = await tx`
      insert into public.devices (user_id, name, platform, arch, app_version, last_seen_at)
      values (${p.user_id}, ${p.device_name}, ${p.platform}, ${p.arch}, ${p.app_version}, now()) returning id`;
    await tx`insert into public.device_secrets (device_id, token_hash, channel_key) values (${d.id}, ${sha256(token)}, ${channelKey})`;
    await tx`update public.device_pairings set delivered_at = now(), device_id = ${d.id} where id = ${p.id}`;
    return { userId: p.user_id as string, deviceId: d.id as string, channelKey };
  });
  if (out === null) return json({ status: 'expired' }, 410);
  if (out === 'pending') return json({ status: 'pending' });
  const [profile] = await db()`select email, display_name from public.profiles where id = ${out.userId}`;
  return json({
    status: 'approved',
    deviceId: out.deviceId,
    token,
    channel: `device:${out.channelKey}`,
    account: { email: profile?.email, name: profile?.display_name },
    supabase: { url: env.supabaseUrl, key: env.supabaseKey },
  });
});
