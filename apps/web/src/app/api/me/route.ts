import { requireUser } from '@/lib/auth';
import { env } from '@/lib/env';
import { json, route } from '@/lib/http';
import { maskEmail } from '@/lib/mfa-rules';
import { canUsePlatform } from '@/lib/models';

// Feature flags and two-step sign-in status for the signed-in user. Answers before two-step
// sign-in is finished too: the sign-in page uses it to know what to ask for.
export const GET = route(async (req) => {
  const user = await requireUser(req, { mfa: 'skip' });
  const s = user.mfa!;
  return json({
    id: user.id,
    email: user.email,
    flags: { platform: canUsePlatform(user), testModel: env.testModel, push: !!env.vapidPublic },
    mfa: {
      method: s.method,
      satisfied: s.satisfied,
      stepUpUntil: s.stepUpUntil,
      stepUpWith: s.stepUpWith,
      totp: s.facts.totp,
      recoveryCodes: s.facts.recoveryCodes,
      email: s.facts.email,
      emailHint: maskEmail(user.email),
    },
  });
});
