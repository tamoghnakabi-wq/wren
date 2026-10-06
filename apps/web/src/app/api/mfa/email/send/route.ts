import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { body, json, route } from '@/lib/http';
import { sendEmailCode } from '@/lib/mfa';

// Email a verification code (Supabase Auth email OTP): to finish signing in, to confirm a sensitive
// action, or to turn email codes on. Rate-limited per user. The answer names the request the code
// belongs to; checking the code needs it.
export const POST = route(async (req) => {
  const user = await requireUser(req, { mfa: 'skip' });
  const { purpose } = await body(req, z.object({ purpose: z.enum(['sign_in', 'step_up', 'enable']) }));
  return json({ ok: true, ...(await sendEmailCode(user, purpose)) });
});
