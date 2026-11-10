'use client';

import { api } from './api';

export interface Attachment {
  artifactId: string;
  name: string;
  mime: string;
  size: number;
}

/** The most an attachment can be (the server's limit, USER_UPLOAD_BYTES). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Up to here a file goes through Wren's API in one request (a request carries at most 4.5 MB). */
export const INLINE_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * Attach a file. A small one goes through the API as it is. A larger one can't (the hosting platform
 * refuses the request before Wren sees it), so it goes straight to the file store: the API says where
 * and gives a token for that one place, the bytes go there, and the API then records what arrived.
 */
export async function uploadFile(f: File): Promise<Attachment> {
  if (f.size > MAX_UPLOAD_BYTES) throw new Error(`${f.name} is larger than 25 MB, the most an attachment can be.`);
  if (f.size <= INLINE_UPLOAD_BYTES) {
    const form = new FormData();
    form.append('file', f);
    return api<Attachment>('/api/files', { form });
  }
  const place = await api<{ id: string; pathname: string; token: string }>('/api/files/upload', { body: { name: f.name, size: f.size } });
  const { put } = await import('@vercel/blob/client');
  try {
    await put(place.pathname, f, { access: 'private', token: place.token, contentType: f.type || undefined });
  } catch {
    throw new Error(`${f.name} couldn’t be uploaded. Check your connection and try again.`);
  }
  return api<Attachment>('/api/files/upload', { method: 'PUT', body: { id: place.id, name: f.name } });
}
