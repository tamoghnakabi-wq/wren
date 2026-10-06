import { requireUser } from '@/lib/auth';
import { db, type Json } from '@/lib/db';
import { body, json, notFound, route, uuid } from '@/lib/http';
import { AgentSchema, normaliseAgent } from '@/lib/agents';
import { assertPlatformAllowed } from '@/lib/platform-credits';
import { SandboxHost } from '@/lib/runner/sandbox-host';

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const b = normaliseAgent(await body(req, AgentSchema));
  const sql = db();
  const [cur] = await sql`select * from public.agents where id = ${id} and user_id = ${user.id}`;
  if (!cur) notFound('Agent not found.');
  // Switching an agent to Wren credits needs them on; an agent already on them can still be edited (its runs are refused).
  if (b.model?.source === 'platform' && (cur.model as { source?: string } | null)?.source !== 'platform') assertPlatformAllowed(user);
  const tools = b.tools ? { ...(cur.tools as object), ...b.tools } : cur.tools;
  const [a] = await sql`
    update public.agents set
      name = ${b.name ?? cur.name}, icon = ${b.icon ?? cur.icon}, color = ${b.color ?? cur.color},
      instructions = ${b.instructions ?? cur.instructions}, model = ${sql.json((b.model ?? cur.model) as Json)},
      runtime = ${b.runtime ?? cur.runtime}, device_id = ${b.deviceId === undefined ? cur.device_id : b.deviceId},
      tools = ${sql.json(tools as Json)}, autonomy = ${b.autonomy ?? cur.autonomy},
      memory_enabled = ${b.memoryEnabled ?? cur.memory_enabled}
    where id = ${id} returning *`;
  return json(a);
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const sql = db();
  const [a] = await sql`update public.agents set archived_at = now() where id = ${id} and user_id = ${user.id} returning id`;
  if (!a) notFound('Agent not found.');
  await sql`update public.runs set cancel_requested = true where agent_id = ${id} and status in ('queued', 'running', 'waiting', 'paused')`;
  await sql`update public.schedules set enabled = false where agent_id = ${id}`;
  // Remove the agent's cloud computer and browser (and their snapshots).
  await SandboxHost.deleteComputers(id);
  return json({ ok: true });
});
