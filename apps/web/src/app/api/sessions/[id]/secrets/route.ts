import { secretNameProblem, SECRET_MAX_CHARS } from '@wren/core';
import { z } from 'zod';
import { HttpError, requireUser } from '@/lib/auth';
import { body, json, route, uuid } from '@/lib/http';
import { answerSecret, removeSecret } from '@/lib/task-secrets';

type Ctx = { params: Promise<{ id: string }> };

// A secret card (task.request_secret): the user saves the value for the task, or declines.
export const POST = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const b = await body(req, z.union([z.object({ eventId: z.string().uuid(), value: z.string().max(SECRET_MAX_CHARS * 2) }), z.object({ eventId: z.string().uuid(), decline: z.literal(true) })]));
  return json(await answerSecret(user.id, id, b.eventId, 'value' in b ? { value: b.value } : { decline: true }));
});

// The card's Remove: the task's commands don't get it any more.
export const DELETE = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const name = new URL(req.url).searchParams.get('name') ?? '';
  if (secretNameProblem(name)) throw new HttpError(400, 'No such secret.', 'invalid');
  await removeSecret(user.id, id, name);
  return json({ ok: true });
});
