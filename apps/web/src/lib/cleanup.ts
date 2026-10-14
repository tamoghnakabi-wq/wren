import { BlobNotFoundError, del } from '@vercel/blob';
import { Sandbox } from '@vercel/sandbox';
import { db } from './db';

// Deleting what lives outside the database: a removed agent's cloud computers (with their snapshots)
// and stored files. What doesn't go through at once is kept in external_cleanups and retried by the
// cron until confirmed (W-157), so deleting an agent or an account never silently leaves them behind.

type Kind = 'sandbox' | 'blob';

/** Each provider says "not found" its own way: Sandbox with a 404 response, Blob with its own error (W-161). */
const notFound = (kind: Kind, e: unknown) => (kind === 'blob' ? e instanceof BlobNotFoundError : (e as { response?: Response }).response?.status === 404);

/**
 * Delete one thing; true once it's gone (or never existed). A computer's snapshots that no other computer
 * uses are deleted too (the provider does that part asynchronously). Each call is bounded, so one slow
 * provider can't use up the cron's time.
 */
async function remove(kind: Kind, ref: string): Promise<boolean> {
  const signal = AbortSignal.timeout(20_000);
  try {
    if (kind === 'sandbox') {
      const sb = await Sandbox.get({ name: ref, resume: false, signal });
      await sb.delete({ deleteOrphanSnapshots: true, signal });
    } else {
      await del(ref, { abortSignal: signal });
    }
    return true;
  } catch (e) {
    if (notFound(kind, e)) return true;
    throw e;
  }
}

/** Delete it now; if that fails, keep it for the cron to retry. */
export async function cleanUp(kind: Kind, ref: string): Promise<void> {
  try {
    if (await remove(kind, ref)) return;
  } catch (e) {
    await db()`
      insert into public.external_cleanups (kind, ref, last_error) values (${kind}, ${ref}, ${String((e as Error).message ?? e).slice(0, 500)})
      on conflict (kind, ref) do update set last_error = excluded.last_error, next_at = now()`;
  }
}

/** Retry kept deletions that are due (cron); how many were done. */
export async function runCleanups(limit = 10): Promise<number> {
  const sql = db();
  // xmin is the row's version: a row renewed meanwhile (another failure for the same thing, perhaps a
  // computer made again under that name) is left for the next round rather than acknowledged (W-162).
  const due = await sql`select id, kind, ref, attempts, xmin::text as version from public.external_cleanups where next_at <= now() order by next_at limit ${limit}`;
  let done = 0;
  for (const c of due) {
    try {
      await remove(c.kind as Kind, c.ref);
      const gone = await sql`delete from public.external_cleanups where id = ${c.id} and xmin::text = ${c.version} returning id`;
      if (gone.length) done++;
    } catch (e) {
      // Back off: 1, 2, 4… minutes, at most a day between tries.
      const minutes = Math.min(24 * 60, 2 ** Math.min(Number(c.attempts), 11));
      await sql`update public.external_cleanups set attempts = attempts + 1, last_error = ${String((e as Error).message ?? e).slice(0, 500)},
        next_at = now() + make_interval(mins => ${minutes}) where id = ${c.id} and xmin::text = ${c.version}`;
    }
  }
  return done;
}
