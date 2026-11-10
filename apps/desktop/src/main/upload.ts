import { deviceFetch, deviceJson } from './api';

// Sending a file a task shares (or a screenshot) to Wren. Wren's API takes a request of at most 4.5 MB
// (the hosting platform refuses anything larger before Wren sees it: "Upload failed (413)" for every
// larger shared file up to 0.1.40), so a larger file goes straight to the file store: the API says
// where and gives a token for that one place, the bytes go there, and the API records what arrived.

/** Up to here a file goes through the API in one request. */
export const INLINE_UPLOAD_BYTES = 4 * 1024 * 1024;

export interface Saved {
  id: string;
  name: string;
  size: number;
}

/** `put` of @vercel/blob/client (a stand-in in tests). */
export type PutFile = (pathname: string, body: Buffer, options: { access: 'private'; token: string }) => Promise<unknown>;

export async function uploadArtifact(u: { runId: string; lease: string; data: Buffer; name: string; kind: 'file' | 'screenshot' }, put?: PutFile): Promise<Saved> {
  if (u.data.length <= INLINE_UPLOAD_BYTES) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(u.data)]), u.name);
    form.append('runId', u.runId);
    form.append('kind', u.kind);
    const res = await deviceFetch('/api/device/artifacts', { method: 'POST', body: form, lease: u.lease });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    return (await res.json()) as Saved;
  }
  const place = await deviceJson<{ id: string; pathname: string; token: string }>('/api/device/artifacts/upload', { runId: u.runId, name: u.name, size: u.data.length }, { lease: u.lease });
  const send = put ?? ((await import('@vercel/blob/client')).put as unknown as PutFile);
  try {
    await send(place.pathname, u.data, { access: 'private', token: place.token });
  } catch (e) {
    throw new Error(`Upload failed: the file store didn’t take the file (${(e as Error).message})`);
  }
  return deviceJson<Saved>('/api/device/artifacts/upload', { runId: u.runId, id: place.id, name: u.name, kind: u.kind }, { lease: u.lease, method: 'PUT' });
}
