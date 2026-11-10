import { z } from 'zod';
import { HttpError, requireDevice, type AuthDevice } from '@/lib/auth';
import { DEVICE_UPLOAD_BYTES, finishUpload, startUpload } from '@/lib/blob';
import { db } from '@/lib/db';
import { body, json, route, uuid } from '@/lib/http';

// Files a desktop run shares that are too large to come through the API (see lib/blob.ts): POST hands
// out a token for one place in the file store, the app sends the bytes there, PUT records what arrived.
// Both are for the worker holding the run only, like POST /api/device/artifacts (which smaller files and
// older apps keep using); the lease is checked again, locked, when the file is recorded.
export const maxDuration = 30;

const Name = z.string().min(1).max(300);

async function heldRun(req: Request, device: AuthDevice, runId: string) {
  const [run] = await db()`select id, agent_id, session_id, lease_id from public.runs where id = ${runId} and device_id = ${device.id}`;
  if (!run) throw new HttpError(404, 'Run not found for this device.', 'not_found');
  const lease = req.headers.get('x-wren-lease');
  if (!lease || !/^[0-9a-f-]{36}$/i.test(lease) || lease !== run.lease_id) throw new HttpError(409, 'This computer no longer holds this run.', 'lease_lost');
  return { run, lease };
}

export const POST = route(async (req) => {
  const device = await requireDevice(req);
  const b = await body(req, z.object({ runId: uuid, name: Name, size: z.number().int().positive() }));
  await heldRun(req, device, b.runId);
  return json(await startUpload({ userId: device.userId, name: b.name, size: b.size, maxBytes: DEVICE_UPLOAD_BYTES }), 201);
});

export const PUT = route(async (req) => {
  const device = await requireDevice(req);
  const b = await body(req, z.object({ runId: uuid, id: uuid, name: Name, kind: z.enum(['file', 'screenshot']).default('file') }));
  const { run, lease } = await heldRun(req, device, b.runId);
  const a = await finishUpload({ userId: device.userId, id: b.id, name: b.name, maxBytes: DEVICE_UPLOAD_BYTES, agentId: run.agent_id, sessionId: run.session_id, runId: run.id, kind: b.kind, source: 'desktop', leaseId: lease });
  return json(a, 201);
});
