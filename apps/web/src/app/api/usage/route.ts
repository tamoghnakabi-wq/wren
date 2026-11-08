import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { json, route } from '@/lib/http';
import { USAGE_DAYS } from '@/lib/usage-days';

// Usage over the last 30 days, summed in the database (row-by-row reads are capped at 1000). Days are
// calendar days in the account's time zone, so the last one is the user's today; `days` lists all of
// them, oldest first, empty ones included.
export const GET = route(async (req) => {
  const user = await requireUser(req);
  const sql = db();
  const [p] = await sql`select timezone from public.profiles where id = ${user.id}`;
  const zone: string = p?.timezone || 'UTC';
  // One transaction, so both queries see the same now().
  const read = (tz: string) =>
    sql.begin(async (tx) => {
      const days = await tx`
        select to_char((now() at time zone ${tz})::date - g, 'YYYY-MM-DD') as day
        from generate_series(${USAGE_DAYS - 1}::int, 0, -1) g`;
      const rows = await tx`
        select to_char(created_at at time zone ${tz}, 'YYYY-MM-DD') as day, agent_id, source, model,
          sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens,
          sum(cached_tokens)::bigint as cached_tokens, count(*)::int as calls
        from public.usage_records
        where user_id = ${user.id}
          and created_at >= ((now() at time zone ${tz})::date - ${USAGE_DAYS - 1}::int)::timestamp at time zone ${tz}
        group by 1, 2, 3, 4`;
      return {
        timezone: tz,
        days: days.map((d) => d.day as string),
        rows: rows.map((r) => ({ ...r, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), cached_tokens: Number(r.cached_tokens) })),
      };
    });
  try {
    return json(await read(zone));
  } catch (e) {
    // Settings accepts any zone Node knows; the database's list can be older ("time zone … not recognized").
    if ((e as { code?: string }).code !== '22023' || zone === 'UTC') throw e;
    return json(await read('UTC'));
  }
});
