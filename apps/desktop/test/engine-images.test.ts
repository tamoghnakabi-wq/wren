import { describe, expect, it } from 'vitest';
import { engineImages, withSkipped } from '../src/engines/images';

const ask = (images: { artifactId: string; mime: string }[], names: Record<string, string>) => ({
  id: 'e',
  type: 'message' as const,
  data: { role: 'user', text: 'look', images, attachments: images.map((i) => ({ artifactId: i.artifactId, name: names[i.artifactId], mime: i.mime, size: 1 })) },
});

describe('images for engines', () => {
  it("loads attached images and names the ones that can't go", async () => {
    const big = 'A'.repeat(Math.ceil((5 * 1024 * 1024 * 4) / 3) + 8);
    const store: Record<string, { found: boolean; mime?: string; data?: string } | null> = {
      a: { found: true, mime: 'image/png', data: 'iVBORw0' },
      b: { found: true, mime: 'image/jpeg', data: big },
      c: { found: false },
    };
    const { images, skipped } = await engineImages(
      [ask([{ artifactId: 'a', mime: 'image/png' }, { artifactId: 'b', mime: 'image/jpeg' }], { a: 'shot.png', b: 'huge.jpg' }), ask([{ artifactId: 'c', mime: 'image/webp' }, { artifactId: 'd', mime: 'image/heic' }], { c: 'gone.webp', d: 'phone.heic' })] as never,
      async (id) => store[id] ?? null,
    );
    expect(images).toEqual([{ mime: 'image/png', data: 'iVBORw0' }]);
    expect(skipped).toEqual(["huge.jpg (it's over 5 MB)", "gone.webp (it couldn't be loaded)", "phone.heic (the model can't read HEIC images)"]);
    expect(withSkipped('look', skipped)).toBe(`look\n\n[Wren couldn't pass on these attached images: ${skipped.join('; ')}.]`);
    expect(withSkipped('look', [])).toBe('look');
  });
});
