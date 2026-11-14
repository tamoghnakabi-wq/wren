import { cachedLoader, isTextAttachment, TEXT_FILE_MAX_BYTES, type LoadAttachment } from '@wren/core';
import { readArtifactBytes } from './blob';
import { db } from './db';

/**
 * Reads the text files attached to an account's messages so the model gets their contents (core
 * `withAttachedText`): only that account's files, only text files, at most 1 MB each.
 */
export function attachmentLoader(userId: string): LoadAttachment {
  return cachedLoader(async (id) => {
    const [a] = await db()`select blob_path, name, mime, size from public.artifacts where id = ${id} and user_id = ${userId}`;
    if (!a || !isTextAttachment({ name: a.name, mime: a.mime, size: Number(a.size) })) return null;
    const bytes = await readArtifactBytes(a.blob_path);
    return bytes && bytes.length <= TEXT_FILE_MAX_BYTES ? new Uint8Array(bytes) : null;
  });
}
