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

/**
 * The images attached to the messages an engine is given now, loaded through `load` (the device API, which
 * only returns this run's account's images). What can't be passed on is named, so the prompt can say so.
 */
export async function engineImages(
  asks: SessionEvent[],
  load: (artifactId: string) => Promise<{ found: boolean; mime?: string; data?: string } | null>,
): Promise<{ images: EngineImage[]; skipped: string[] }> {
  const images: EngineImage[] = [];
  const skipped: string[] = [];
  for (const e of asks) {
    const d = e.data as MessageData;
    for (const img of d.images ?? []) {
      const name = d.attachments?.find((a) => a.artifactId === img.artifactId)?.name ?? 'an image';
      if (!TYPES.has(img.mime)) skipped.push(`${name} (the model can't read ${img.mime.replace('image/', '').toUpperCase()} images)`);
      else if (images.length >= MAX_IMAGES) skipped.push(`${name} (only ${MAX_IMAGES} images can go with one message)`);
      else {
        const r = img.data ? { found: true, mime: img.mime, data: img.data } : img.artifactId ? await load(img.artifactId).catch(() => null) : null;
        if (!r?.found || !r.data || !r.mime) skipped.push(`${name} (it couldn't be loaded)`);
        else if (Math.floor((r.data.length * 3) / 4) > MAX_BYTES) skipped.push(`${name} (it's over 5 MB)`);
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
