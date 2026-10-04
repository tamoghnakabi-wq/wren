import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { body, json, route } from '@/lib/http';
import { startTask } from '@/lib/runs';

export const maxDuration = 60;

const Schema = z.object({
  agentId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  text: z.string().max(20000).default(''),
  runtime: z.enum(['cloud', 'desktop']).optional(),
  deviceId: z.string().uuid().optional(),
  attachments: z.array(z.object({ artifactId: z.string().uuid(), name: z.string(), mime: z.string(), size: z.number() })).max(10).optional(),
});

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const b = await body(req, Schema);
  const r = await startTask({ userId: user.id, ...b });
  return json(r, 201);
});
