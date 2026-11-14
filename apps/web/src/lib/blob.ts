import { cleanUp } from './cleanup';
import { BlobNotFoundError, get, head, put } from '@vercel/blob';
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
import { randomUUID } from 'node:crypto';
import { HttpError } from './auth';
import { db } from './db';

// Private artifact storage (Vercel Blob, private store). Files are only ever
// served through /api/files/[id], which checks ownership.

export interface ArtifactInput {
  userId: string;
  agentId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  name: string;
  mime: string;
  data: Buffer | Uint8Array;
  kind?: 'file' | 'screenshot' | 'upload' | 'page';
  source?: 'cloud' | 'desktop' | 'user';
  /** For files a run produces: saved only while this lease still holds the run. */
  leaseId?: string;
}

const safeName = (n: string) => n.replace(/[^\w.\- ()]+/g, '_').slice(-120) || 'file';

export async function saveArtifact(a: ArtifactInput): Promise<{ id: string; name: string; size: number; mime: string }> {
  const id = randomUUID();
  const name = safeName(a.name);
  const path = `u/${a.userId}/${id}/${name}`;
  await put(path, Buffer.isBuffer(a.data) ? a.data : Buffer.from(a.data), { access: 'private', contentType: a.mime, addRandomSuffix: false, allowOverwrite: false });
  const size = a.data.byteLength;
  const sql = db();
  // A run's file is recorded only if the worker still holds the run (share-locked, so a takeover
  // waits for this insert and anything after it sees the new owner); otherwise the upload is removed.
  const rows = await sql`
    insert into public.artifacts (id, user_id, agent_id, session_id, run_id, name, mime, size, kind, blob_path, source)
    select ${id}, ${a.userId}, ${a.agentId ?? null}, ${a.sessionId ?? null}, ${a.runId ?? null}, ${name}, ${a.mime}, ${size}, ${a.kind ?? 'file'}, ${path}, ${a.source ?? 'cloud'}
    where ${a.leaseId && a.runId ? sql`exists (select 1 from public.runs where id = ${a.runId}::uuid and lease_id = ${a.leaseId}::uuid for share)` : sql`true`}
    returning id`.catch(async (e: unknown) => {
    // The record failed (e.g. the account is being deleted): nothing stays behind. The record's error is
    // the one reported; a failure to clean up as well is logged.
    await deleteArtifactBlob(path).catch((ce: Error) => console.error(`[wren] removing unrecorded upload ${path}: ${ce.message}`));
    throw e;
  });
  if (!rows.length) {
    await deleteArtifactBlob(path);
    throw new HttpError(409, 'This worker no longer holds this run.', 'lease_lost');
  }
  return { id, name, size, mime: a.mime };
}

// ---------------------------------------------------------------- direct uploads
//
// A request to a Vercel Function carries at most 4.5 MB (the platform answers 413 before Wren's code
// runs), so a file can't come through the API. Larger ones go straight to the Blob store in three steps:
//   1. startUpload: Wren picks the file's place and hands out a token good for that one place and size;
//   2. the browser or the desktop app sends the bytes to the store with it;
//   3. finishUpload: Wren looks at what arrived and records it.
// The place is written down in external_cleanups before the token goes out (due in two hours), so an
// upload nobody finishes is deleted by the cron, and only a place written down there can be recorded:
// finishing can't adopt some other stored file.

/** What a small file may be and still go through the API in one request (under the platform's 4.5 MB). */
export const INLINE_UPLOAD_BYTES = 4 * 1024 * 1024;
/** The most a file someone attaches may be, and the most a file a computer shares may be. */
export const USER_UPLOAD_BYTES = 25 * 1024 * 1024;
export const DEVICE_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Uploads one account may have under way at a time. */
const PENDING_UPLOADS = 20;
/** How long an upload has from start to finish. */
const UPLOAD_MINUTES = 120;
/** The marker of a place that waits for its upload (a failed deletion carries its error here instead). */
const PENDING_UPLOAD = 'upload not finished';

const uploadPath = (userId: string, id: string, name: string) => `u/${userId}/${id}/${safeName(name)}`;

export async function startUpload(u: { userId: string; name: string; size: number; maxBytes: number }): Promise<{ id: string; pathname: string; token: string }> {
  if (!Number.isSafeInteger(u.size) || u.size < 1) throw new HttpError(400, 'Attach a file.', 'invalid');
  if (u.size > u.maxBytes) throw new HttpError(413, `Files can be up to ${Math.round(u.maxBytes / (1024 * 1024))} MB.`, 'too_large');
  const id = randomUUID();
  const pathname = uploadPath(u.userId, id, u.name);
  // Written down only while the account has few under way, in one statement (no count-then-insert race worth a lock).
  const noted = await db()`
    insert into public.external_cleanups (kind, ref, last_error, next_at)
    select 'blob', ${pathname}, ${PENDING_UPLOAD}, now() + make_interval(mins => ${UPLOAD_MINUTES})
    where (select count(*) from public.external_cleanups where kind = 'blob' and last_error = ${PENDING_UPLOAD} and starts_with(ref, ${`u/${u.userId}/`})) < ${PENDING_UPLOADS}
    returning id`;
  if (!noted.length) throw new HttpError(429, 'Too many uploads at once. Wait for some to finish and try again.', 'too_many');
  // Good for this one place, once (no overwrite), up to the size limit, for half an hour to begin.
  const token = await generateClientTokenFromReadWriteToken({ pathname, maximumSizeInBytes: u.maxBytes, validUntil: Date.now() + 30 * 60_000, addRandomSuffix: false, allowOverwrite: false });
  return { id, pathname, token };
}

export async function finishUpload(a: Omit<ArtifactInput, 'data' | 'mime'> & { id: string; maxBytes: number }): Promise<{ id: string; name: string; size: number; mime: string }> {
  const name = safeName(a.name);
  const path = uploadPath(a.userId, a.id, a.name);
  const stored = await head(path).catch((e: unknown) => {
    if (e instanceof BlobNotFoundError) return null;
    throw e;
  });
  if (!stored) throw new HttpError(400, 'The file didn’t arrive. Attach it again.', 'upload_missing');
  if (stored.size > a.maxBytes) {
    await deleteArtifactBlob(path);
    throw new HttpError(413, `Files can be up to ${Math.round(a.maxBytes / (1024 * 1024))} MB.`, 'too_large');
  }
  const mime = stored.contentType && stored.contentType !== 'application/octet-stream' ? stored.contentType : guessMime(name);
  const sql = db();
  const out = await sql.begin(async (tx) => {
    // Only a place Wren handed out, and not one the cron is about to clear (it takes those that are due).
    const pending = await tx`
      delete from public.external_cleanups
      where kind = 'blob' and ref = ${path} and last_error = ${PENDING_UPLOAD} and next_at > now() + interval '1 minute' returning id`;
    if (!pending.length) return 'expired' as const;
    const rows = await tx`
      insert into public.artifacts (id, user_id, agent_id, session_id, run_id, name, mime, size, kind, blob_path, source)
      select ${a.id}, ${a.userId}, ${a.agentId ?? null}, ${a.sessionId ?? null}, ${a.runId ?? null}, ${name}, ${mime}, ${stored.size}, ${a.kind ?? 'file'}, ${path}, ${a.source ?? 'cloud'}
      where ${a.leaseId && a.runId ? tx`exists (select 1 from public.runs where id = ${a.runId}::uuid and lease_id = ${a.leaseId}::uuid for share)` : tx`true`}
      returning id`;
    // Not recorded: the place stays written down (the delete above is undone), and the cron clears it.
    if (!rows.length) throw new HttpError(409, 'This worker no longer holds this run.', 'lease_lost');
    return 'saved' as const;
  });
  if (out === 'expired') throw new HttpError(410, 'That upload took too long. Attach the file again.', 'upload_expired');
  return { id: a.id, name, size: stored.size, mime };
}

export async function readArtifact(blobPath: string): Promise<{ stream: ReadableStream; contentType: string } | null> {
  const r = await get(blobPath, { access: 'private' });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return { stream: r.stream, contentType: r.blob.contentType };
}

export async function readArtifactBytes(blobPath: string): Promise<Buffer | null> {
  const r = await readArtifact(blobPath);
  if (!r) return null;
  return Buffer.from(await new Response(r.stream).arrayBuffer());
}

/** Delete a stored file; if that fails now, the cron retries it (W-157). */
export async function deleteArtifactBlob(blobPath: string) {
  await cleanUp('blob', blobPath);
}

export function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html', pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    zip: 'application/zip', js: 'text/javascript', ts: 'text/plain', py: 'text/x-python', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mp4: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
  };
  return map[ext] ?? 'application/octet-stream';
}
