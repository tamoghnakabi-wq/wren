import type postgres from 'postgres';
import webpush from 'web-push';
import { db } from './db';
import { env } from './env';

// Notifications: an in-app row (shown live through Realtime), a Web Push to every browser/phone
// subscribed from a sign-in that is still live, and a wake-up for the user's desktop apps.

let vapidReady = false;
function vapid() {
  if (vapidReady || !env.vapidPublic || !env.vapidPrivate) return vapidReady;
  webpush.setVapidDetails(env.vapidSubject, env.vapidPublic, env.vapidPrivate);
  vapidReady = true;
  return true;
}

export interface NotifyInput {
  userId: string;
  kind: string;
  title: string;
  body?: string;
  url?: string;
  sessionId?: string | null;
  tag?: string;
}

/**
 * Saves the in-app notification and pushes it. With `when` (a SQL condition, e.g. that a worker still
 * holds its run's lease) the row goes in only if the condition holds in that same statement, and
 * nothing is pushed otherwise (W-200). Returns whether it was saved.
 */
export async function notifyUser(n: NotifyInput, when?: postgres.Fragment): Promise<boolean> {
  const sql = db();
  const rows = await sql`
    insert into public.notifications (user_id, kind, title, body, url, session_id)
    select ${n.userId}::uuid, ${n.kind}, ${n.title.slice(0, 200)}, ${(n.body ?? '').slice(0, 2000)}, ${n.url ?? null}, ${n.sessionId ?? null}::uuid
    where ${when ?? sql`true`}
    returning id`;
  if (!rows.length) return false;
  await sendPush(n).catch((e) => console.warn('push failed', e?.message));
  return true;
}

/** Only the browsers' own push services: the server makes requests to these URLs. */
export function isPushServiceEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password) return false;
  return /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9-]+\.)*push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/i.test(u.hostname);
}

export async function sendPush(n: NotifyInput): Promise<number> {
  if (!vapid()) return 0;
  const sql = db();
  // Only browsers whose own sign-in is still live and has finished two-step sign-in (W-199): one that
  // signed out, or whose session ended or was revoked, gets nothing more (migration 0013).
  const subs = await sql`select id, endpoint, p256dh, auth from public.wren_push_targets(${n.userId}::uuid)`;
  const payload = JSON.stringify({ title: n.title, body: n.body ?? '', url: n.url ?? '/app', tag: n.tag ?? n.kind });
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      if (!isPushServiceEndpoint(s.endpoint)) return;
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: n.kind === 'approval' ? 'high' : 'normal', timeout: 8000 });
        sent++;
        await sql`update public.push_subscriptions set last_used_at = now() where id = ${s.id}`;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await sql`delete from public.push_subscriptions where id = ${s.id}`;
      }
    }),
  );
  return sent;
}

/**
 * Wake a desktop device so it fetches new work immediately. A public broadcast channel named by a random
 * key only the device and the server know (not a private, RLS-checked one): send nothing on it but this.
 */
export async function nudgeDevice(deviceId: string, reason: string): Promise<void> {
  const sql = db();
  const rows = await sql`select channel_key from public.device_secrets where device_id = ${deviceId}`;
  if (!rows.length) return;
  await sql`select realtime.send(${sql.json({ reason, at: Date.now() })}, 'wake', ${'device:' + rows[0].channel_key}, false)`;
}

export async function nudgeUserDevices(userId: string, reason: string): Promise<void> {
  const sql = db();
  const rows = await sql`
    select s.channel_key from public.device_secrets s join public.devices d on d.id = s.device_id
    where d.user_id = ${userId} and d.revoked_at is null`;
  for (const r of rows) await sql`select realtime.send(${sql.json({ reason, at: Date.now() })}, 'wake', ${'device:' + r.channel_key}, false)`;
}
