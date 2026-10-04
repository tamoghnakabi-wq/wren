import { z } from 'zod';
import { requireDevice } from '@/lib/auth';
import { db, type Json } from '@/lib/db';
import { body, json, route } from '@/lib/http';
import { connectionSecret, userSettings } from '@/lib/models';

// Desktop heartbeat: reports what the device can do and returns its work.
const Schema = z.object({
  appVersion: z.string().max(30).optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  policy: z.record(z.string(), z.unknown()).optional(),
});

export const POST = route(async (req) => {
  const device = await requireDevice(req);
  const b = await body(req, Schema);
  const sql = db();
  await sql`
    update public.devices set last_seen_at = now(),
      app_version = coalesce(${b.appVersion ?? null}, app_version),
      capabilities = coalesce(${b.capabilities ? sql.json(b.capabilities as Json) : null}, capabilities),
      policy = coalesce(${b.policy ? sql.json(b.policy as Json) : null}, policy)
    where id = ${device.id}`;
  const runs = await sql`
    select id, status, cancel_requested, pause_requested, lease_until from public.runs
    where device_id = ${device.id} and runtime = 'desktop' and status in ('queued', 'running')
    order by created_at limit 20`;
  const settings = { ...(await userSettings(device.userId)), openaiKey: !!(await connectionSecret(device.userId, 'openai')) };
  const [profile] = await sql`select email, display_name from public.profiles where id = ${device.userId}`;
  return json({
    device: { id: device.id, name: device.name },
    account: { email: profile?.email, name: profile?.display_name },
    settings,
    work: runs.map((r) => ({ id: r.id, status: r.status, cancel: r.cancel_requested, pause: r.pause_requested, leased: r.lease_until ? new Date(r.lease_until) > new Date() : false })),
  });
});
