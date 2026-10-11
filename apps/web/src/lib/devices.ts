import { db } from './db';
import { finishRun } from './runs';

/**
 * Unlink a device (removed in Settings, or the desktop giving its token back): the token stops working at
 * once, and the device's unfinished tasks end as cancelled, since nothing is left to end them (W-147).
 */
export async function revokeDevice(deviceId: string): Promise<void> {
  // Together, so a retry never finds it half done (the token would no longer let the device retry).
  await db().begin(async (tx) => {
    await tx`update public.devices set revoked_at = coalesce(revoked_at, now()) where id = ${deviceId}`;
    await tx`delete from public.device_secrets where device_id = ${deviceId}`;
  });
  await endOrphanedRuns(deviceId);
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
  for (const r of runs) {
    if ((await finishRun(r.id, { kind: 'cancelled', steps: 0 }, undefined, { orphaned: true })) === 'ended') ended++;
  }
  return ended;
}
