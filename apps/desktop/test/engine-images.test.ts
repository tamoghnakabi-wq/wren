import { describe, expect, it } from 'vitest';
import { engineImages, withSkipped } from '../src/engines/images';

const ask = (images: { artifactId: string; mime: string }[], names: Record<string, string>) => ({
  id: 'e',
  type: 'message' as const,
  data: { role: 'user', text: 'look', images, attachments: images.map((i) => ({ artifactId: i.artifactId, name: names[i.artifactId], mime: i.mime, size: 1 })) },
});

describe('images for engines', () => {
  it('keep only real PNG/JPEG/GIF/WebP bytes, whatever the type says', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64');
    const { images, skipped } = await engineImages(
      [ask([{ artifactId: 'p', mime: 'image/png' }, { artifactId: 'j', mime: 'image/jpeg' }, { artifactId: 's', mime: 'image/png' }], { p: 'fake.png', j: 'real.jpg', s: 'drawing.png' })] as never,
      async (id) => (id === 'p' ? { found: true, mime: 'image/png', data: jpeg } : id === 'j' ? { found: true, mime: 'image/jpeg', data: jpeg } : { found: true, mime: 'image/svg+xml', data: svg }),
    );
    expect(images).toEqual([{ mime: 'image/jpeg', data: jpeg }]);
    expect(skipped).toEqual(["fake.png (it isn't a PNG, JPEG, GIF or WebP image)", "drawing.png (it isn't a PNG, JPEG, GIF or WebP image)"]);
  });

  it('stop when the run is stopped or its lease is gone, instead of skipping (W-122)', async () => {
    const one = [ask([{ artifactId: 'a', mime: 'image/png' }], { a: 'shot.png' })] as never;
    const stopped = new AbortController();
    stopped.abort();
    await expect(engineImages(one, async () => ({ found: true, mime: 'image/png', data: 'x' }), stopped.signal)).rejects.toThrow();
    await expect(engineImages(one, async () => Promise.reject(Object.assign(new Error('lease'), { status: 409 })))).rejects.toThrow('lease');
    // Anything else only skips that image.
    expect((await engineImages(one, async () => Promise.reject(new Error('network')))).skipped).toEqual(["shot.png (it couldn't be loaded)"]);
  });

  it("loads attached images and names the ones that can't go", async () => {
    const big = 'A'.repeat(Math.ceil((5 * 1024 * 1024 * 4) / 3) + 8);
    const store: Record<string, { found: boolean; mime?: string; data?: string } | null> = {
      a: { found: true, mime: 'image/png', data: 'iVBORw0KGgo=' },
      b: { found: true, mime: 'image/jpeg', data: big },
      c: { found: false },
    };
    const { images, skipped } = await engineImages(
      [ask([{ artifactId: 'a', mime: 'image/png' }, { artifactId: 'b', mime: 'image/jpeg' }], { a: 'shot.png', b: 'huge.jpg' }), ask([{ artifactId: 'c', mime: 'image/webp' }, { artifactId: 'd', mime: 'image/heic' }], { c: 'gone.webp', d: 'phone.heic' })] as never,
      async (id) => store[id] ?? null,
    );
    expect(images).toEqual([{ mime: 'image/png', data: 'iVBORw0KGgo=' }]);
    expect(skipped).toEqual(["huge.jpg (it's over 5 MB)", "gone.webp (it couldn't be loaded)", "phone.heic (the model can't read HEIC images)"]);
    expect(withSkipped('look', skipped)).toBe(`look\n\n[Wren couldn't pass on these attached images: ${skipped.join('; ')}.]`);
    expect(withSkipped('look', [])).toBe('look');
  });
});
