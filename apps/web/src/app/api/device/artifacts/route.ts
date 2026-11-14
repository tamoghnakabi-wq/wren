import { PAGE_MAX_BYTES } from '@wren/core';
import { HttpError, requireDevice } from '@/lib/auth';
import { DEVICE_UPLOAD_BYTES, guessMime, saveArtifact } from '@/lib/blob';
import { db } from '@/lib/db';
import { json, route } from '@/lib/http';

// Files shared by a desktop run (share_file, screenshots, pages), up to 50 MB. On Vercel a request carries at
// most 4.5 MB, so the app (0.1.41+) sends larger files through /api/device/artifacts/upload.
export const maxDuration = 60;

export const POST = route(async (req) => {
  const device = await requireDevice(req);
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  const runId = String(form?.get('runId') ?? '');
  const asked = String(form?.get('kind') ?? 'file');
  const kind = asked === 'screenshot' ? 'screenshot' : asked === 'page' ? 'page' : 'file';
  if (!(file instanceof File)) throw new HttpError(400, 'Attach a file.', 'invalid');
  if (file.size > DEVICE_UPLOAD_BYTES) throw new HttpError(413, 'Files can be up to 50 MB.', 'too_large');
  // A page an agent made (task.show_page): HTML, as small as the tool allows; only ever shown sandboxed (/api/pages).
  if (kind === 'page' && file.size > PAGE_MAX_BYTES) throw new HttpError(413, `Pages can be up to ${PAGE_MAX_BYTES / 1024} KB.`, 'too_large');
  const [run] = await db()`select id, agent_id, session_id, status, lease_id from public.runs where id = ${runId} and device_id = ${device.id}`;
  if (!run) throw new HttpError(404, 'Run not found for this device.', 'not_found');
  // Only the worker holding the run: its lease is checked here and again, locked, when the file
  // is recorded (an upload that outlives the lease is discarded).
  const lease = req.headers.get('x-wren-lease');
  if (!lease || !/^[0-9a-f-]{36}$/i.test(lease) || lease !== run.lease_id) throw new HttpError(409, 'This computer no longer holds this run.', 'lease_lost');
  const a = await saveArtifact({ userId: device.userId, agentId: run.agent_id, sessionId: run.session_id, runId: run.id, name: file.name, mime: kind === 'page' ? 'text/html' : file.type || guessMime(file.name), data: Buffer.from(await file.arrayBuffer()), kind, source: 'desktop', leaseId: lease });
  return json(a, 201);
});
