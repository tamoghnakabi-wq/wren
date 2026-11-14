import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import { HttpError, requireUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { body, json, route } from '@/lib/http';
import { likePattern, MAX_QUERY, searchableInMessages, searchWords, snippet, tsQuery, type SearchMessage, type SearchResult, type SearchTask } from '@/lib/search';

export const maxDuration = 15;

// The ⌘K palette's search over the caller's own tasks: titles that have every word, and tasks where a
// message (the user's or an agent's) has every word, newest first. A POST, so what was searched for never
// lands in request logs as part of an address. Messages are found through the events_message_words index
// (migration 0016): the expression below must stay the same as the index's (MESSAGE_WORDS_SQL). The index
// spans every account, so a search that would take long is cut off (2 s) rather than left to run.
export const POST = route(async (req) => {
  const user = await requireUser(req);
  const { q } = await body(req, z.object({ q: z.string().max(MAX_QUERY * 4) }));
  const words = searchWords(q);
  if (!words.length) return json({ words, tasks: [], messages: [] } satisfies SearchResult);
  try {
    return json(
      await db().begin(async (tx) => {
        await tx`set local statement_timeout = '2s'`;
        return find(tx, user.id, words);
      }),
    );
  } catch (e) {
    if ((e as { code?: string }).code === '57014') throw new HttpError(503, 'That search took too long. Add another word and try again.', 'search_slow');
    throw e;
  }
});

async function find(tx: TransactionSql, userId: string, words: string[]): Promise<SearchResult> {
  const titles = await tx`
    select id, title, agent_id, status, archived_at, last_event_at from public.sessions
    where user_id = ${userId} and title ilike all(${words.map(likePattern)}::text[])
    order by last_event_at desc limit 8`;
  const tasks = titles.map((s): SearchTask => ({ id: s.id, title: s.title, agentId: s.agent_id, status: s.status, archived: !!s.archived_at, at: iso(s.last_event_at) }));
  if (!searchableInMessages(words)) return { words, tasks, messages: [] };
  // The newest matching message of each task, for the 12 tasks with the newest matches; tasks already found
  // by their title aren't listed again.
  const rows = await tx`
    select m.session_id, m.seq, m.role, m.text, m.created_at, s.title, s.agent_id, s.status, s.archived_at
    from (
      select distinct on (e.session_id) e.session_id, e.seq, e.data->>'role' as role, left(e.data->>'text', 20000) as text, e.created_at
      from public.events e
      where e.user_id = ${userId} and e.type = 'message'
        and to_tsvector('simple'::regconfig, left(coalesce(e.data->>'text', ''), 100000)) @@ to_tsquery('simple'::regconfig, ${tsQuery(words)})
      order by e.session_id, e.seq desc
    ) m
    join public.sessions s on s.id = m.session_id and s.user_id = ${userId}
    where not (m.session_id = any(${tasks.map((t) => t.id)}::uuid[]))
    order by m.created_at desc limit 12`;
  const messages = rows.map(
    (r): SearchMessage => ({
      id: r.session_id,
      title: r.title,
      agentId: r.agent_id,
      status: r.status,
      archived: !!r.archived_at,
      at: iso(r.created_at),
      seq: Number(r.seq),
      role: r.role === 'assistant' ? 'assistant' : 'user',
      snippet: snippet(r.text ?? '', words),
    }),
  );
  return { words, tasks, messages };
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : String(d));
