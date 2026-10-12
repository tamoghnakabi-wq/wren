import { db } from './db';
import { finishRun, taskTx } from './runs';

/**
 * Unlink a device (removed in Settings, or the desktop giving its token back): the token stops working at
 * once, and the device's unfinished tasks end as cancelled, since nothing is left to end them (W-147).
 */
export async function revokeDevice(deviceId: string): Promise<void> {
  // Together, so a retry never finds it half done (the token would no longer let the device retry).
  await taskTx(async (tx) => {
    await tx`update public.devices set revoked_at = coalesce(revoked_at, now()) where id = ${deviceId}`;
    await tx`delete from public.device_secrets where device_id = ${deviceId}`;
  });
  await endOrphanedRuns(deviceId);
}

/**
 * Unlink computers that were handed a sign-in but never checked in with it within 30 minutes: their
 * answer was lost on the way, or they gave it back but couldn't reach Wren to say so (W-151, W-148).
 * A linked computer checks in right after saving it (its first heartbeat moves last_seen_at past the
 * creation time both were set to).
 */
export async function revokeUnclaimedDevices(): Promise<number> {
  const rows = await db()`
    select id from public.devices
    where revoked_at is null and last_seen_at = created_at and created_at < now() - interval '30 minutes'
    order by created_at limit 20`;
  for (const d of rows) await revokeDevice(d.id);
  return rows.length;
}

/**
 * End (cancelled) the unfinished tasks of unlinked computers: they can't report any more. Runs after each
 * unlink, and every minute from the cron for anything that slipped past (an unlink that failed half-way,
 * a claim already under way). Returns how many it ended.
 */
export async function endOrphanedRuns(deviceId?: string): Promise<number> {
  const sql = db();
  const runs = await sql`
    select r.id from public.runs r join public.devices d on d.id = r.device_id
    where r.runtime = 'desktop' and r.status in ('queued', 'running', 'waiting', 'paused') and d.revoked_at is not null
      ${deviceId ? sql`and d.id = ${deviceId}` : sql``}
    order by r.created_at limit 50`;
  let ended = 0;
  let failed: Error | null = null;
  for (const r of runs) {
    // One run that can't be finished now doesn't hold up the others; the cron tries it again.
    try {
      if ((await finishRun(r.id, { kind: 'cancelled', steps: 0 }, undefined, { orphaned: true })) === 'ended') ended++;
    } catch (e) {
      failed ??= e as Error;
    }
  }
  if (failed) throw Object.assign(failed, { ended });
  return ended;
}
