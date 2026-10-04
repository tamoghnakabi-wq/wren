import { HttpError, requireUser } from '@/lib/auth';
import { guessMime, saveArtifact } from '@/lib/blob';
import { json, route } from '@/lib/http';

// User uploads (attachments for a task). 25 MB per file.
export const maxDuration = 60;

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) throw new HttpError(400, 'Attach a file.', 'invalid');
  if (file.size > 25 * 1024 * 1024) throw new HttpError(413, 'Files can be up to 25 MB.', 'too_large');
  const data = Buffer.from(await file.arrayBuffer());
  const a = await saveArtifact({ userId: user.id, name: file.name || 'upload', mime: file.type || guessMime(file.name), data, kind: 'upload', source: 'user' });
  return json({ artifactId: a.id, name: a.name, mime: a.mime, size: a.size }, 201);
});
