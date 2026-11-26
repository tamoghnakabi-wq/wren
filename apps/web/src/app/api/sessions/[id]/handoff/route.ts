import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { body, json, route, uuid } from '@/lib/http';
import { handOff } from '@/lib/runs';

export const maxDuration = 60;

// Carry a task on with another agent: a new task for that agent, with this one's conversation (lib/runs.ts handOff).
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const b = await body(req, z.object({ agentId: z.string().uuid() }));
  return json(await handOff(user.id, id, b.agentId), 201);
});
