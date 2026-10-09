import { requireDevice } from '@/lib/auth';
import { db } from '@/lib/db';
import { json, route } from '@/lib/http';

/**
 * The desktop gives its token back: Unlink on the computer, or a link the user declined there (W-145).
 * Same effect as removing the device in Settings: the token stops working at once.
 */
export const POST = route(async (req) => {
  const device = await requireDevice(req);
  const sql = db();
  await sql`update public.devices set revoked_at = now() where id = ${device.id}`;
  await sql`delete from public.device_secrets where device_id = ${device.id}`;
  await sql`update public.runs set cancel_requested = true where device_id = ${device.id} and status in ('queued', 'running', 'waiting', 'paused')`;
  return json({ ok: true });
});
