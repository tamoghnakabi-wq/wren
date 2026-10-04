import { z } from 'zod';
import { randomToken, sha256 } from '@/lib/crypto';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { body, json, route } from '@/lib/http';

// Desktop pairing, step 3: once the signed-in user approved the code, hand the
// device its long-lived token exactly once.
export const POST = route(async (req) => {
  const b = await body(req, z.object({ pairId: z.string().uuid(), pollSecret: z.string().min(20).max(100) }));
  const sql = db();
  const [p] = await sql`select * from public.device_pairings where id = ${b.pairId} and poll_secret_hash = ${sha256(b.pollSecret)}`;
  if (!p || new Date(p.expires_at) < new Date()) return json({ status: 'expired' }, 410);
  if (p.delivered_at) return json({ status: 'expired' }, 410);
  if (!p.approved_at || !p.user_id) return json({ status: 'pending' });

  const token = randomToken(32);
  const channelKey = randomToken(24);
  const [d] = await sql`
    insert into public.devices (user_id, name, platform, arch, app_version, last_seen_at)
    values (${p.user_id}, ${p.device_name}, ${p.platform}, ${p.arch}, ${p.app_version}, now()) returning id`;
  await sql`insert into public.device_secrets (device_id, token_hash, channel_key) values (${d.id}, ${sha256(token)}, ${channelKey})`;
  const claimed = await sql`update public.device_pairings set delivered_at = now(), device_id = ${d.id} where id = ${p.id} and delivered_at is null returning id`;
  if (!claimed.length) {
    await sql`delete from public.devices where id = ${d.id}`;
    return json({ status: 'expired' }, 410);
  }
  const [profile] = await sql`select email, display_name from public.profiles where id = ${p.user_id}`;
  return json({
    status: 'approved',
    deviceId: d.id,
    token,
    channel: `device:${channelKey}`,
    account: { email: profile?.email, name: profile?.display_name },
    supabase: { url: env.supabaseUrl, key: env.supabaseKey },
  });
});
