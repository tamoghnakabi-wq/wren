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
 * Run `work` for at most `ms`. The signal is aborted with an "AbortError" (not the "TimeoutError" of
 * `AbortSignal.timeout`): Blob's SDK retries anything else, so it would keep going (W-164). The caller gets
 * control back at the deadline either way; an SDK retry still waiting stops at its next attempt.
 */
async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new DOMException('The deletion took too long.', 'AbortError');
      ac.abort(e);
      reject(e);
    }, ms);
  });
  const running = work(ac.signal);
  running.catch(() => {}); // settled after the deadline: nothing is waiting for it any more
  try {
    return await Promise.race([running, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delete one thing; true once it's gone (or never existed). A computer's snapshots that no other computer
 * uses are deleted too (the provider does that part asynchronously). Each call is bounded, so one slow
 * provider can't use up the cron's time.
 */
const REMOVE_MS = 15_000;

async function remove(kind: Kind, ref: string): Promise<boolean> {
  try {
    await withDeadline(REMOVE_MS, async (signal) => {
      if (kind === 'sandbox') {
        const sb = await Sandbox.get({ name: ref, resume: false, signal });
        await sb.delete({ deleteOrphanSnapshots: true, signal });
      } else {
        await del(ref, { abortSignal: signal });
      }
    });
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

/**
 * Retry kept deletions that are due (cron); how many were done. Each starts only if it can end (at its own
 * time limit) within `budgetMs`, so the whole batch ends within it too, give or take the database.
 */
export async function runCleanups(limit = 10, budgetMs = 35_000): Promise<number> {
  const started = Date.now();
  const sql = db();
  // xmin is the row's version: a row renewed meanwhile (another failure for the same thing, perhaps a
  // computer made again under that name) is left for the next round rather than acknowledged (W-162).
  const due = await sql`select id, kind, ref, attempts, xmin::text as version from public.external_cleanups where next_at <= now() order by next_at limit ${limit}`;
  let done = 0;
  for (const c of due) {
    if (Date.now() - started + REMOVE_MS > budgetMs) break; // the rest wait for the next minute
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
