import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { body, json, route } from '@/lib/http';
import { verifyEmailCode } from '@/lib/mfa';

// Check an emailed code for this session (Supabase checks the code itself).
export const POST = route(async (req) => {
  const user = await requireUser(req, { mfa: 'skip' });
  const { code } = await body(req, z.object({ code: z.string().max(20) }));
  const purpose = await verifyEmailCode(user, code);
  return json({ ok: true, purpose });
});
