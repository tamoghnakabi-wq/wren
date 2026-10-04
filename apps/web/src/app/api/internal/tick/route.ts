import { after } from 'next/server';
import { z } from 'zod';
import { HttpError } from '@/lib/auth';
import { safeEqual } from '@/lib/crypto';
import { env } from '@/lib/env';
import { body, json, route } from '@/lib/http';
import { runTick } from '@/lib/runner/tick';

// Internal: execute one tick of a cloud run. Responds immediately and does the
// work after the response, so the caller (previous tick, API, cron) never waits.
export const maxDuration = 300;

export const POST = route(async (req) => {
  if (!safeEqual(req.headers.get('x-wren-internal') ?? '', env.internalSecret)) throw new HttpError(401, 'Forbidden', 'forbidden');
  const { runId } = await body(req, z.object({ runId: z.string().uuid() }));
  after(async () => {
    try {
      const r = await runTick(runId);
      console.log(`[tick] ${runId.slice(0, 8)} -> ${r}`);
    } catch (e) {
      console.error('[tick] failed', runId, e);
    }
  });
  return json({ accepted: true }, 202);
});
