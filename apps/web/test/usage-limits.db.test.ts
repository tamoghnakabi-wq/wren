import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A plan's usage limit against a real Postgres with Wren's migrations: the task pauses and says when it
// carries on, the cron's `limits` stage wakes it then, "Don't resume" and the account's setting keep it
// paused, and a message sent meanwhile waits for it. Also the ⌘K search's queries. Runs only when
// WREN_TEST_DB names a local database (the local Supabase stack); a throwaway user is created and removed.
const URL = process.env.WREN_TEST_DB ?? '';
const local = /@(127\.0\.0\.1|localhost)[:/]/.test(URL);

vi.stubGlobal('fetch', async () => new Response('{}')); // pushes: nothing to reach in tests
const userId = randomUUID();
// The search route as the caller: real database, search and http helpers (tests don't resolve `@/`).
vi.mock('@/lib/auth', async () => ({ ...(await import('../src/lib/auth')), requireUser: async () => ({ id: userId }) }));
vi.mock('@/lib/db', () => import('../src/lib/db'));
vi.mock('@/lib/http', () => import('../src/lib/http'));
vi.mock('@/lib/search', () => import('../src/lib/search'));

describe.skipIf(!local)('usage limits and search (database)', () => {
  let sql: postgres.Sql;
  let runs: typeof import('../src/lib/runs');
  let agentId = '';
  const HOUR = 3_600_000;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    sql = postgres(URL, { onnotice: () => {} });
    runs = await import('../src/lib/runs');
    await sql`insert into auth.users (id, email, aud, role) values (${userId}, ${`limits-${userId.slice(0, 8)}@example.test`}, 'authenticated', 'authenticated')`;
    await sql`update public.profiles set timezone = 'Australia/Melbourne' where id = ${userId}`;
    const [d] = await sql`insert into public.devices (user_id, name, platform, last_seen_at) values (${userId}, 'Test Mac', 'darwin', now()) returning id`;
    const [a] = await sql`insert into public.agents (user_id, name, instructions, model, runtime, device_id, autonomy, tools)
      values (${userId}, 'Claude', 'I help.', ${sql.json({ source: 'claude-code', model: 'default' })}, 'desktop', ${d.id}, 'balanced', '{}'::jsonb) returning id`;
    agentId = a.id;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from public.notifications where user_id = ${userId}`;
    await sql`delete from public.sessions where user_id = ${userId}`;
    await sql`delete from public.agents where user_id = ${userId}`;
    await sql`delete from public.devices where user_id = ${userId}`;
    await sql`delete from auth.users where id = ${userId}`;
    await sql.end();
    const { db } = await import('../src/lib/db');
    await db().end();
  });

  beforeEach(async () => {
    await sql`delete from public.sessions where user_id = ${userId}`;
    await sql`delete from public.notifications where user_id = ${userId}`;
    await sql`update public.profiles set settings = '{}'::jsonb where id = ${userId}`;
  });

  /** A task whose run a worker holds, which then reports the plan's limit. */
  async function limited(resetAt?: number, text = 'Write the report') {
    const t = await runs.startTask({ userId, agentId, text });
    const lease = randomUUID();
    await sql`update public.runs set status = 'running', lease_id = ${lease}, lease_until = now() + interval '2 minutes' where id = ${t.runId}`;
    const out = await runs.finishRun(t.runId, { kind: 'paused', steps: 2, limit: { error: 'Claude Code: You’ve hit your limit', code: 'claude_usage_limit', ...(resetAt ? { resetAt } : {}), midTurn: true } }, lease);
    return { ...t, out };
  }
  const run = async (id: string) => (await sql`select status, wake_at, pause_requested, lease_id from public.runs where id = ${id}`)[0];
  const lines = async (runId: string) => (await sql`select data from public.events where run_id = ${runId} and type = 'status' order by seq`).map((e) => e.data);

  it('pauses at the limit and says when it carries on', async () => {
    const reset = Date.now() + HOUR;
    const t = await limited(reset);
    expect(t.out).toBe('paused');
    const r = await run(t.runId);
    expect(r).toMatchObject({ status: 'paused', pause_requested: false, lease_id: null });
    const wake = (r.wake_at as Date).getTime();
    expect(wake).toBeGreaterThanOrEqual(reset + 60_000);
    expect(wake).toBeLessThanOrEqual(reset + 120_000);
    expect((await sql`select status from public.sessions where id = ${t.sessionId}`)[0].status).toBe('paused');
    const [line] = await lines(t.runId);
    expect(line).toMatchObject({ code: 'usage_limit', level: 'warn', cause: 'claude_usage_limit', resetAt: reset, wakeAt: wake });
    const [n] = await sql`select kind, title, body from public.notifications where user_id = ${userId}`;
    expect(n).toMatchObject({ kind: 'run_limited', title: 'Claude hit a usage limit' });
    expect(n.body).toMatch(/^Write the report: it carries on (at|tomorrow at) \d/);
  });

  it('waits for the user with no reset time, the setting off, or a reset days away', async () => {
    const none = await limited();
    expect((await run(none.runId)).wake_at).toBeNull();
    expect((await sql`select body from public.notifications where user_id = ${userId}`)[0].body).toMatch(/paused\. Resume it when you're ready\./);
    const weekly = await limited(Date.now() + 3 * 24 * HOUR);
    expect((await run(weekly.runId)).wake_at).toBeNull();
    await sql`update public.profiles set settings = '{"resumeAfterLimits": false}'::jsonb where id = ${userId}`;
    const off = await limited(Date.now() + HOUR);
    expect((await run(off.runId)).wake_at).toBeNull();
  });

  it('carries on when the reset comes (the cron), once', async () => {
    const t = await limited(Date.now() + HOUR);
    expect(await runs.resumeLimitedRuns()).toBe(0); // not yet
    await sql`update public.runs set wake_at = now() - interval '1 second' where id = ${t.runId}`;
    expect(await runs.resumeLimitedRuns()).toBe(1);
    expect(await run(t.runId)).toMatchObject({ status: 'queued', wake_at: null });
    expect((await sql`select status from public.sessions where id = ${t.sessionId}`)[0].status).toBe('queued');
    expect((await lines(t.runId)).at(-1)).toMatchObject({ code: 'limit_reset', level: 'info' });
    expect(await runs.resumeLimitedRuns()).toBe(0);
  });

  it('stays paused after "Don’t resume", or when the setting was turned off meanwhile', async () => {
    const held = await limited(Date.now() + HOUR);
    await runs.holdRun(userId, held.runId);
    expect(await run(held.runId)).toMatchObject({ status: 'paused', wake_at: null, pause_requested: true });
    const later = await limited(Date.now() + HOUR);
    await sql`update public.runs set wake_at = now() - interval '1 second' where id = ${later.runId}`;
    await sql`update public.profiles set settings = '{"resumeAfterLimits": false}'::jsonb where id = ${userId}`;
    expect(await runs.resumeLimitedRuns()).toBe(0);
    expect(await run(later.runId)).toMatchObject({ status: 'paused', wake_at: null });
    // Resume still carries either on.
    await runs.resumeRun(userId, held.runId);
    expect(await run(held.runId)).toMatchObject({ status: 'queued', pause_requested: false });
  });

  it('keeps a message sent meanwhile for when it carries on, but a limit with no time takes the message as Resume', async () => {
    const t = await limited(Date.now() + HOUR);
    const sent = await runs.startTask({ userId, agentId, text: 'Also add a summary', sessionId: t.sessionId });
    expect(sent).toMatchObject({ runId: t.runId, continued: true });
    expect((await run(t.runId)).status).toBe('paused');
    expect((await sql`select count(*)::int as n from public.events where run_id = ${t.runId} and type = 'message'`)[0].n).toBe(2);
    const open = await limited(undefined, 'Other task');
    await runs.startTask({ userId, agentId, text: 'Go on', sessionId: open.sessionId });
    expect((await run(open.runId)).status).toBe('queued');
  });

  it('stops carrying on by itself after a few limits in one run', async () => {
    const t = await limited(Date.now() + HOUR);
    for (let i = 1; i < runs.MAX_LIMIT_RESUMES; i++) {
      const lease = randomUUID();
      await sql`update public.runs set status = 'running', lease_id = ${lease}, lease_until = now() + interval '2 minutes' where id = ${t.runId}`;
      await runs.finishRun(t.runId, { kind: 'paused', steps: 3, limit: { error: 'limit', resetAt: Date.now() + HOUR } }, lease);
      expect((await run(t.runId)).wake_at).not.toBeNull();
    }
    const lease = randomUUID();
    await sql`update public.runs set status = 'running', lease_id = ${lease}, lease_until = now() + interval '2 minutes' where id = ${t.runId}`;
    await runs.finishRun(t.runId, { kind: 'paused', steps: 4, limit: { error: 'limit', resetAt: Date.now() + HOUR } }, lease);
    expect((await run(t.runId)).wake_at).toBeNull();
  });

  it('a user’s own Pause never wakes by itself', async () => {
    const t = await runs.startTask({ userId, agentId, text: 'Long job' });
    await runs.pauseRun(userId, t.runId);
    expect(await run(t.runId)).toMatchObject({ status: 'paused', wake_at: null, pause_requested: true });
    // Paused by the user while the limit came: still no wake-up.
    const lease = randomUUID();
    await sql`update public.runs set status = 'running', lease_id = ${lease}, lease_until = now() + interval '2 minutes', pause_requested = true where id = ${t.runId}`;
    await runs.finishRun(t.runId, { kind: 'paused', steps: 1, limit: { error: 'limit', resetAt: Date.now() + HOUR } }, lease);
    expect((await run(t.runId)).wake_at).toBeNull();
  });

  describe('search', () => {
    const search = async (q: string) => {
      const { POST } = await import('../src/app/api/search/route');
      const res = await (POST as unknown as (r: Request) => Promise<Response>)(new Request('http://x/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q }) }));
      return (await res.json()) as import('../src/lib/search').SearchResult;
    };

    it('finds tasks by title and by what was said, newest first, without repeating a task', async () => {
      const a = await runs.startTask({ userId, agentId, text: 'Compare the quarterly invoices for Acme' });
      const b = await runs.startTask({ userId, agentId, text: 'Book flights' });
      await sql`update public.sessions set title = 'Invoices check' where id = ${a.sessionId}`;
      await sql`insert into public.events (user_id, session_id, run_id, type, status, data)
        values (${userId}, ${b.sessionId}, ${b.runId}, 'message', 'done', ${sql.json({ role: 'assistant', text: 'I found 3 flights. The Acme invoices are paid, by the way.' })})`;
      const r = await search('acme invo');
      expect(r.words).toEqual(['acme', 'invo']);
      expect(r.tasks).toEqual([]); // no title has both words
      expect(r.messages.map((m) => m.id).sort()).toEqual([a.sessionId, b.sessionId].sort());
      const hit = r.messages.find((m) => m.id === b.sessionId)!;
      expect(hit).toMatchObject({ role: 'assistant', title: 'Book flights' });
      expect(hit.snippet).toContain('Acme invoices are paid');
      const t = await search('invoices');
      expect(t.tasks.map((x) => x.id)).toEqual([a.sessionId]);
      expect(t.messages.map((m) => m.id)).toEqual([b.sessionId]); // a's message isn't listed again
    });

    it('treats what the user types as words only, and sees only the caller’s tasks', async () => {
      await runs.startTask({ userId, agentId, text: 'Rename 50%_off banner' });
      const typed = await search("50%_off' | !x & (y:*");
      expect(typed.words).toEqual(['50', 'off']);
      expect(typed.tasks.length + typed.messages.length).toBe(1); // its title has both words
      expect(await search('&&& |||')).toEqual({ words: [], tasks: [], messages: [] });
      const other = randomUUID();
      await sql`insert into auth.users (id, email, aud, role) values (${other}, ${`other-${other.slice(0, 8)}@example.test`}, 'authenticated', 'authenticated')`;
      try {
        const [s] = await sql`insert into public.sessions (user_id, agent_id, title) values (${other}, ${agentId}, 'banner secret') returning id`.catch(() => [undefined]);
        const r = await search('banner');
        expect(r.tasks.concat(r.messages).every((x) => x.id !== s?.id)).toBe(true);
      } finally {
        await sql`delete from public.sessions where user_id = ${other}`;
        await sql`delete from auth.users where id = ${other}`;
      }
    });

    it('uses the message index', async () => {
      const plan = await sql.unsafe(`explain select 1 from public.events e where e.user_id = '${userId}' and e.type = 'message' and to_tsvector('simple'::regconfig, left(coalesce(e.data->>'text', ''), 100000)) @@ to_tsquery('simple'::regconfig, 'acme')`);
      await sql`set enable_seqscan = off`;
      const forced = await sql.unsafe(`explain select 1 from public.events e where e.type = 'message' and to_tsvector('simple'::regconfig, left(coalesce(e.data->>'text', ''), 100000)) @@ to_tsquery('simple'::regconfig, 'acme')`);
      await sql`set enable_seqscan = on`;
      expect(plan.length).toBeGreaterThan(0);
      expect(JSON.stringify(forced)).toContain('events_message_words');
    });
  });
});
