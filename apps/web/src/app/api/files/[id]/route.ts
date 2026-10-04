import { requireUser } from '@/lib/auth';
import { deleteArtifactBlob, readArtifact } from '@/lib/blob';
import { db } from '@/lib/db';
import { json, notFound, route, uuid } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

// Owner-checked delivery of private artifacts. Inline types that can carry
// script (HTML/SVG) are always downloaded, never rendered on our origin.
const INLINE_SAFE = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/plain|text\/markdown|text\/csv|application\/json|video\/mp4|audio\/(mpeg|wav))$/;

export const GET = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const [a] = await db()`select name, mime, blob_path from public.artifacts where id = ${id} and user_id = ${user.id}`;
  if (!a) notFound('File not found.');
  const r = await readArtifact(a.blob_path);
  if (!r) notFound('File content is missing.');
  const download = new URL(req.url).searchParams.has('download') || !INLINE_SAFE.test(a.mime);
  const type = INLINE_SAFE.test(a.mime) ? a.mime : 'application/octet-stream';
  return new Response(r!.stream, {
    headers: {
      'content-type': type.startsWith('text/') ? `${type}; charset=utf-8` : type,
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      'cache-control': 'private, max-age=3600',
    },
  });
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const [a] = await db()`delete from public.artifacts where id = ${id} and user_id = ${user.id} returning blob_path`;
  if (!a) notFound('File not found.');
  await deleteArtifactBlob(a.blob_path);
  return json({ ok: true });
});
