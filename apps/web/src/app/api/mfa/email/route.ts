import { requireUser } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { disableEmailCodes } from '@/lib/mfa';

// Turn email codes off. Needs a second step verified in the last few minutes.
export const DELETE = route(async (req) => {
  const user = await requireUser(req, { stepUp: true });
  await disableEmailCodes(user);
  return json({ ok: true });
});
