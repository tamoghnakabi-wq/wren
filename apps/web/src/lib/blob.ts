import { del, get, put } from '@vercel/blob';
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
  kind?: 'file' | 'screenshot' | 'upload';
  source?: 'cloud' | 'desktop' | 'user';
  /** For files a run produces: saved only while this lease still holds the run. */
  leaseId?: string;
}

const safeName = (n: string) => n.replace(/[^\w.\- ()]+/g, '_').slice(-120) || 'file';

export async function saveArtifact(a: ArtifactInput): Promise<{ id: string; name: string; size: number; mime: string }> {
  const id = randomUUID();
  const name = safeName(a.name);
  const path = `u/${a.userId}/${id}/${name}`;
  await put(path, Buffer.from(a.data), { access: 'private', contentType: a.mime, addRandomSuffix: false, allowOverwrite: false });
  const size = a.data.byteLength;
  const sql = db();
  // A run's file is recorded only if the worker still holds the run (share-locked, so a takeover
  // waits for this insert and anything after it sees the new owner); otherwise the upload is removed.
  const rows = await sql`
    insert into public.artifacts (id, user_id, agent_id, session_id, run_id, name, mime, size, kind, blob_path, source)
    select ${id}, ${a.userId}, ${a.agentId ?? null}, ${a.sessionId ?? null}, ${a.runId ?? null}, ${name}, ${a.mime}, ${size}, ${a.kind ?? 'file'}, ${path}, ${a.source ?? 'cloud'}
    where ${a.leaseId && a.runId ? sql`exists (select 1 from public.runs where id = ${a.runId}::uuid and lease_id = ${a.leaseId}::uuid for share)` : sql`true`}
    returning id`;
  if (!rows.length) {
    await deleteArtifactBlob(path);
    throw new HttpError(409, 'This worker no longer holds this run.', 'lease_lost');
  }
  return { id, name, size, mime: a.mime };
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

export async function deleteArtifactBlob(blobPath: string) {
  await del(blobPath).catch(() => {});
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
