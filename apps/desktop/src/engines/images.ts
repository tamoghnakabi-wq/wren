import type { MessageData, SessionEvent } from '@wren/core';

/** An image an engine gets with its prompt (base64, no data: prefix). */
export interface EngineImage {
  mime: string;
  data: string;
}

/** Formats both Claude and Grok read. */
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** The models' own per-image limit (Anthropic: 5 MB). */
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 10;
/** Downloads per prompt, kept or not (oversized or broken ones count too). */
const MAX_LOADS = 20;

/** The bytes are what the type says: an upload's type comes from the browser, not from its contents. */
function looksLike(mime: string, b64: string): boolean {
  const b = Buffer.from(b64.slice(0, 24), 'base64');
  const ascii = (from: number, to: number) => b.subarray(from, to).toString('latin1');
  if (mime === 'image/png') return b[0] === 0x89 && ascii(1, 4) === 'PNG';
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === 'image/gif') return ascii(0, 4) === 'GIF8';
  if (mime === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  return false;
}

/**
 * The images attached to the messages an engine is given now, loaded through `load` (the device API, which
 * only returns this run's account's images). What can't be passed on is named, so the prompt can say so.
 */
export async function engineImages(
  asks: SessionEvent[],
  load: (artifactId: string) => Promise<{ found: boolean; mime?: string; data?: string } | null>,
  signal?: AbortSignal,
): Promise<{ images: EngineImage[]; skipped: string[] }> {
  // A run that was stopped, or whose lease is gone, stops here; other failures only skip that image.
  const fetchOne = async (id: string) => {
    try {
      return await load(id);
    } catch (e) {
      if (signal?.aborted || (e as { status?: number }).status === 409) throw e;
      return null;
    }
  };
  const images: EngineImage[] = [];
  const skipped: string[] = [];
  let loads = 0;
  for (const e of asks) {
    const d = e.data as MessageData;
    for (const img of d.images ?? []) {
      const name = d.attachments?.find((a) => a.artifactId === img.artifactId)?.name ?? 'an image';
      if (!TYPES.has(img.mime)) skipped.push(`${name} (the model can't read ${img.mime.replace('image/', '').toUpperCase()} images)`);
      else if (images.length >= MAX_IMAGES || loads >= MAX_LOADS) skipped.push(`${name} (only ${MAX_IMAGES} images can go with one message)`);
      else {
        loads++;
        if (signal?.aborted) throw new Error('Stopped');
        const r = img.data ? { found: true, mime: img.mime, data: img.data } : img.artifactId ? await fetchOne(img.artifactId) : null;
        if (!r?.found || !r.data || !r.mime) skipped.push(`${name} (it couldn't be loaded)`);
        else if (Math.floor((r.data.length * 3) / 4) > MAX_BYTES) skipped.push(`${name} (it's over 5 MB)`);
        else if (!TYPES.has(r.mime) || !looksLike(r.mime, r.data)) skipped.push(`${name} (it isn't a PNG, JPEG, GIF or WebP image)`);
        else images.push({ mime: r.mime, data: r.data });
      }
    }
  }
  return { images, skipped };
}

/** The prompt, saying which attached images the engine didn't get. */
export function withSkipped(prompt: string, skipped: string[]): string {
  return skipped.length ? `${prompt}\n\n[Wren couldn't pass on these attached images: ${skipped.join('; ')}.]` : prompt;
}
