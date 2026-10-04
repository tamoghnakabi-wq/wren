import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { db, type Json } from '@/lib/db';
import { body, json, route } from '@/lib/http';
import { deleteArtifactBlob } from '@/lib/blob';
import { Sandbox } from '@vercel/sandbox';
import { SandboxHost } from '@/lib/runner/sandbox-host';

const Schema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  timezone: z.string().max(64).optional(),
  onboarded: z.boolean().optional(),
  settings: z
    .object({
      openaiAccess: z.enum(['chatgpt', 'api']),
      openaiAllowFallback: z.boolean(),
      chatgptWelcomed: z.boolean(),
      notifyOnComplete: z.boolean(),
      notifyOnApproval: z.boolean(),
    })
    .partial()
    .optional(),
});

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const b = await body(req, Schema);
  if (b.timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: b.timezone });
    } catch {
      return json({ error: 'Unknown timezone.' }, 400);
    }
  }
  const sql = db();
  const [p] = await sql`
    update public.profiles set
      display_name = coalesce(${b.displayName ?? null}, display_name),
      timezone = coalesce(${b.timezone ?? null}, timezone),
      onboarded_at = case when ${b.onboarded ?? false} then coalesce(onboarded_at, now()) else onboarded_at end,
      settings = settings || ${sql.json((b.settings ?? {}) as Json)}
    where id = ${user.id} returning *`;
  return json(p);
});

/** Delete the account and everything in it. */
export const DELETE = route(async (req) => {
  const user = await requireUser(req);
  const { confirm } = await body(req, z.object({ confirm: z.literal('DELETE') }));
  if (confirm !== 'DELETE') return json({ error: 'Type DELETE to confirm.' }, 400);
  const sql = db();
  // Remove stored files and the agents' cloud computers before the rows go.
  const blobs = await sql`select blob_path from public.artifacts where user_id = ${user.id}`;
  for (const b of blobs) await deleteArtifactBlob(b.blob_path);
  const agents = await sql`select id from public.agents where user_id = ${user.id}`;
  for (const a of agents) {
    try {
      const sb = await Sandbox.get({ name: SandboxHost.sandboxName(a.id), resume: false });
      await sb.delete();
    } catch {
      /* none */
    }
  }
  await sql`select public.wren_delete_account(${user.id})`;
  return json({ ok: true });
});
