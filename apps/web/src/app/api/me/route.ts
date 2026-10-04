import { requireUser } from '@/lib/auth';
import { env } from '@/lib/env';
import { json, route } from '@/lib/http';
import { canUsePlatform } from '@/lib/models';

// Feature flags for the signed-in user.
export const GET = route(async (req) => {
  const user = await requireUser(req);
  return json({ id: user.id, email: user.email, flags: { platform: canUsePlatform(user), testModel: env.testModel, push: !!env.vapidPublic } });
});
