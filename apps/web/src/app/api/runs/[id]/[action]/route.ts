import { HttpError, requireUser } from '@/lib/auth';
import { json, route, uuid } from '@/lib/http';
import { cancelRun, pauseRun, resumeRun } from '@/lib/runs';

export const maxDuration = 30;

export const POST = route<{ params: Promise<{ id: string; action: string }> }>(async (req, ctx) => {
  const user = await requireUser(req);
  const p = await ctx.params;
  const id = uuid.parse(p.id);
  if (p.action === 'cancel') await cancelRun(user.id, id);
  else if (p.action === 'pause') await pauseRun(user.id, id);
  else if (p.action === 'resume') await resumeRun(user.id, id);
  else throw new HttpError(404, 'Unknown action.', 'not_found');
  return json({ ok: true });
});
