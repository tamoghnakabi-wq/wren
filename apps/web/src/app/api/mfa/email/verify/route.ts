import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { body, json, route } from '@/lib/http';
import { verifyEmailCode } from '@/lib/mfa';

// Check an emailed code for the request it was sent for (Supabase checks the code itself).
export const POST = route(async (req) => {
  const user = await requireUser(req, { mfa: 'skip' });
  const { code, challengeId, purpose } = await body(req, z.object({ code: z.string().max(20), challengeId: z.string().uuid(), purpose: z.enum(['sign_in', 'step_up', 'enable']) }));
  return json({ ok: true, purpose: await verifyEmailCode(user, code, challengeId, purpose) });
});
