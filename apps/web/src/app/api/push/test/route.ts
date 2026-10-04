import { requireUser } from '@/lib/auth';
import { json, route } from '@/lib/http';
import { sendPush } from '@/lib/notify';

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const sent = await sendPush({ userId: user.id, kind: 'test', title: 'Notifications are on', body: 'Wren will tell you when agents finish or need you.', url: '/app/settings' });
  return json({ sent });
});
