import { requireDevice } from '@/lib/auth';
import { revokeDevice } from '@/lib/devices';
import { json, route } from '@/lib/http';

/**
 * The desktop gives its token back: Unlink on the computer, or a link the user declined there (W-145).
 * Same as removing the device in Settings: the token stops working at once and its tasks end (W-147).
 */
export const POST = route(async (req) => {
  const device = await requireDevice(req);
  await revokeDevice(device.id);
  return json({ ok: true });
});
