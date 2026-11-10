import { z } from 'zod';
import { requireUser } from '@/lib/auth';
import { finishUpload, startUpload, USER_UPLOAD_BYTES } from '@/lib/blob';
import { body, json, route, uuid } from '@/lib/http';

// Attachments too large to come through the API (a request carries at most 4.5 MB here) go straight to
// the file store: POST says where and hands out a token for that one place, the browser sends the bytes
// there, and PUT records what arrived (see lib/blob.ts). Smaller files keep using POST /api/files.
export const maxDuration = 30;

const Name = z.string().min(1).max(300);

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const b = await body(req, z.object({ name: Name, size: z.number().int().positive() }));
  return json(await startUpload({ userId: user.id, name: b.name, size: b.size, maxBytes: USER_UPLOAD_BYTES }), 201);
});

export const PUT = route(async (req) => {
  const user = await requireUser(req);
  const b = await body(req, z.object({ id: uuid, name: Name }));
  const a = await finishUpload({ userId: user.id, id: b.id, name: b.name, maxBytes: USER_UPLOAD_BYTES, kind: 'upload', source: 'user' });
  return json({ artifactId: a.id, name: a.name, mime: a.mime, size: a.size }, 201);
});
