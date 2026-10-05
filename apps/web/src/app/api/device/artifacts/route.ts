import { HttpError, requireDevice } from '@/lib/auth';
import { guessMime, saveArtifact } from '@/lib/blob';
import { db } from '@/lib/db';
import { json, route } from '@/lib/http';

// Files shared by a desktop run (share_file, screenshots). 50 MB per file.
export const maxDuration = 60;

export const POST = route(async (req) => {
  const device = await requireDevice(req);
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  const runId = String(form?.get('runId') ?? '');
  const kind = String(form?.get('kind') ?? 'file') === 'screenshot' ? 'screenshot' : 'file';
  if (!(file instanceof File)) throw new HttpError(400, 'Attach a file.', 'invalid');
  if (file.size > 50 * 1024 * 1024) throw new HttpError(413, 'Files can be up to 50 MB.', 'too_large');
  const [run] = await db()`select id, agent_id, session_id, status, lease_id from public.runs where id = ${runId} and device_id = ${device.id}`;
  if (!run) throw new HttpError(404, 'Run not found for this device.', 'not_found');
  // Only the worker holding the run (0.1.6+ sends its lease; older apps only while the run is active).
  const lease = req.headers.get('x-wren-lease');
  if (lease ? lease !== run.lease_id : run.status !== 'running') throw new HttpError(409, 'This computer no longer holds this run.', 'lease_lost');
  const a = await saveArtifact({ userId: device.userId, agentId: run.agent_id, sessionId: run.session_id, runId: run.id, name: file.name, mime: file.type || guessMime(file.name), data: Buffer.from(await file.arrayBuffer()), kind, source: 'desktop' });
  return json(a, 201);
});
