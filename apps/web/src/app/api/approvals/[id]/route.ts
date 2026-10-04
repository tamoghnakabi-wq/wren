import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { body, json, route, uuid } from '@/lib/http';
import { decideApproval } from '@/lib/runs';

export const maxDuration = 30;

const Schema = z.object({ approve: z.boolean(), note: z.string().max(500).optional(), via: z.enum(['web', 'mobile', 'desktop', 'push']).default('web') });

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const b = await body(req, Schema);
  return json(await decideApproval(user.id, id, b.approve, b.via, b.note));
});
