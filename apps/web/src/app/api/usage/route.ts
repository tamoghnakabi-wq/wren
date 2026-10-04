import { requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { json, route } from '@/lib/http';

// Usage over the last 30 days, summed in the database (row-by-row reads are capped at 1000).
export const GET = route(async (req) => {
  const user = await requireUser(req);
  const rows = await db()`
    select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day, agent_id, source, model,
      sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens,
      sum(cached_tokens)::bigint as cached_tokens, count(*)::int as calls
    from public.usage_records
    where user_id = ${user.id} and created_at >= now() - interval '30 days'
    group by 1, 2, 3, 4`;
  return json({
    rows: rows.map((r) => ({ ...r, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), cached_tokens: Number(r.cached_tokens) })),
  });
});
