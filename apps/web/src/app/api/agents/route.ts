import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { db, type Json } from '@/lib/db';
import { body, json, route } from '@/lib/http';
import { AgentSchema, normaliseAgent } from '@/lib/agents';
import { assertPlatformAllowed } from '@/lib/platform-credits';

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const b = normaliseAgent(await body(req, AgentSchema.extend({ name: z.string().trim().min(1).max(60) })));
  if (b.model?.source === 'platform') assertPlatformAllowed(user);
  const sql = db();
  const [count] = await sql`select count(*)::int as n from public.agents where user_id = ${user.id} and archived_at is null`;
  if (count.n >= 30) return json({ error: 'You can have up to 30 agents.' }, 400);
  const [a] = await sql`
    insert into public.agents (user_id, name, icon, color, instructions, model, runtime, device_id, tools, autonomy, memory_enabled)
    values (${user.id}, ${b.name!}, ${b.icon ?? 'sparkles'}, ${b.color ?? 'violet'}, ${b.instructions ?? ''}, ${sql.json((b.model ?? {}) as Json)},
            ${b.runtime ?? 'cloud'}, ${b.deviceId ?? null}, ${sql.json((b.tools ?? {}) as Json)}, ${b.autonomy ?? 'balanced'}, ${b.memoryEnabled ?? true})
    returning *`;
  return json(a, 201);
});
