import { requireDevice } from '@/lib/auth';
import { db } from '@/lib/db';
import { json, route } from '@/lib/http';

// Remote approvals were turned off on this computer: approvals already waiting for its runs become
// approvable on this computer only, like new ones. (decideApproval re-checks this flag in the same
// transaction that records a decision, so a remote decision can't slip in afterwards.)
export const POST = route(async (req) => {
  const device = await requireDevice(req);
  const rows = await db()`
    update public.approvals a set detail = coalesce(a.detail, '{}'::jsonb) || '{"localOnly": true}'::jsonb
    from public.runs r
    where a.run_id = r.id and r.device_id = ${device.id} and r.user_id = ${device.userId} and a.status = 'pending'
    returning a.id`;
  return json({ updated: rows.length });
});
