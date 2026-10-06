import { z } from 'zod';
import { accessToken, HttpError, requireUser } from '@/lib/auth';
import { body, json, route } from '@/lib/http';
import { changePassword } from '@/lib/mfa';

// Choose a new password (after a reset link, or from a signed-in session). Accounts with two-step
// sign-in confirm it's them first (a second step in the last few minutes). With email codes on this
// is the only way to change the password: Supabase Auth's own endpoint refuses it (migration 0010).
export const POST = route(async (req) => {
  const user = await requireUser(req);
  const s = user.mfa!;
  if (s.method !== 'none' && !s.stepUpUntil) throw new HttpError(403, 'Confirm it’s you to continue.', 'step_up_required');
  const { password } = await body(req, z.object({ password: z.string().min(8).max(200) }));
  const token = await accessToken(req);
  if (!token) throw new HttpError(401, 'Sign in required.', 'unauthenticated');
  await changePassword(user, token, password, s.facts.email);
  return json({ ok: true });
});
