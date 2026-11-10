import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Agents asking agents (task.ask_agent) against a real Postgres with Wren's migrations: who may ask whom,
// the link and limits, the answer reaching the asker, and Stop reaching the agents it asked. Runs only
// when WREN_TEST_DB names a local database (e.g. the local Supabase stack); a throwaway user is created
// and removed. Every agent here works on a (fake) computer, so nothing calls out to the cloud.
const URL = process.env.WREN_TEST_DB ?? '';
const local = /@(127\.0\.0\.1|localhost)[:/]/.test(URL);

vi.stubGlobal('fetch', async () => new Response('{}')); // kickTick and pushes: nothing to reach in tests

describe.skipIf(!local)('agents asking agents (database)', () => {
  let sql: postgres.Sql;
  let runs: typeof import('../src/lib/runs');
  const userId = randomUUID();
  let deviceId = '';
  const agent: Record<string, string> = {};

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    sql = postgres(URL, { onnotice: () => {} });
    runs = await import('../src/lib/runs');
    await sql`insert into auth.users (id, email, aud, role) values (${userId}, ${`asks-${userId.slice(0, 8)}@example.test`}, 'authenticated', 'authenticated')`;
    const [d] = await sql`insert into public.devices (user_id, name, platform, last_seen_at) values (${userId}, 'Test Mac', 'darwin', now()) returning id`;
    deviceId = d.id;
    const add = async (name: string, autonomy: string, source: string) => {
      const [a] = await sql`insert into public.agents (user_id, name, instructions, model, runtime, device_id, autonomy, tools)
        values (${userId}, ${name}, ${`I am ${name}.\nMore.`}, ${sql.json({ source, model: 'default' })}, 'desktop', ${deviceId}, ${autonomy}, '{}'::jsonb) returning id`;
      agent[name] = a.id;
    };
    await add('Grok', 'balanced', 'grok-build');
    await add('Claude', 'autonomous', 'claude-code');
    await add('Scout', 'careful', 'openai');
    await sql`update public.agents set tools = ${sql.json({ agents: [agent.Claude, agent.Scout] })} where id = ${agent.Grok}`;
  });

  afterAll(async () => {
    if (!sql) return;
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
    await sql`update public.devices set last_seen_at = now() where id = ${deviceId}`;
  });

  /** A running task of Grok's with one ask_agent step (whose id is the ask key). */
  async function askingTask() {
    const t = await runs.startTask({ userId, agentId: agent.Grok, text: 'Plan the launch' });
    await sql`update public.runs set status = 'running', lease_id = ${randomUUID()}, lease_until = now() + interval '2 minutes' where id = ${t.runId}`;
    const step = async () => {
      const [e] = await sql`insert into public.events (user_id, session_id, run_id, type, status, data)
        values (${userId}, ${t.sessionId}, ${t.runId}, 'tool', 'running', ${sql.json({ callId: randomUUID(), name: 'task.ask_agent', args: {}, title: 'Ask', risk: 'low' })}) returning id`;
      return e.id as string;
    };
    return { ...t, step };
  }
  type RunRow = { id: string; user_id: string; agent_id: string; trigger: string; status: string; autonomy_cap: string | null };
  const run = async (id: string) => (await sql`select * from public.runs where id = ${id}`)[0] as RunRow;
  const childRun = async (sessionId: string) => (await sql`select * from public.runs where session_id = ${sessionId}`)[0] as RunRow;
  const ask = (runId: string, key: string, who = 'Claude', question = 'Is the plan sound?') => runs.askAgent({ userId, runId, key, agent: who, question });

  it('starts the asked agent’s task linked to the asker, with the stricter autonomy, once per key', async () => {
    const t = await askingTask();
    const key = await t.step();
    const r = await ask(t.runId, key, 'claude'); // names match regardless of case
    expect(r).toMatchObject({ agent: 'Claude' });
    const sessionId = (r as { sessionId: string }).sessionId;
    const [s] = await sql`select * from public.sessions where id = ${sessionId}`;
    expect(s).toMatchObject({ agent_id: agent.Claude, parent_session_id: t.sessionId, parent_run_id: t.runId, parent_ask_key: key });
    const c = await childRun(sessionId);
    // Claude is autonomous, Grok balanced: the asked task works as balanced.
    expect(c).toMatchObject({ trigger: 'agent', autonomy_cap: 'balanced', status: 'queued' });
    expect(runs.stricter('autonomous', c.autonomy_cap)).toBe('balanced');
    expect(runs.stricter('careful', c.autonomy_cap)).toBe('careful');
    const [msg] = await sql`select data from public.events where run_id = ${c.id} and type = 'message'`;
    expect(msg.data.text).toBe('Is the plan sound?');
    expect(msg.data.context).toContain('This question comes from Grok');
    expect(msg.data.context).toContain('"Plan the launch"');
    // Asked again with the same key (a re-run step): the same task, nothing new.
    expect(await ask(t.runId, key)).toEqual(r);
    expect((await sql`select count(*)::int as n from public.sessions where parent_run_id = ${t.runId}`)[0].n).toBe(1);
  });

  it('refuses agents the user didn’t pick, the asker itself, and asks from an asked agent', async () => {
    const t = await askingTask();
    const key = await t.step();
    expect(await ask(t.runId, key, 'Grok')).toMatchObject({ error: expect.stringContaining('isn’t one of the agents you may ask (you may ask: Claude, Scout)') });
    expect(await ask(t.runId, key, 'Nobody')).toMatchObject({ error: expect.stringContaining('isn’t one of the agents') });
    // Claude's own task (asked by Grok) can't ask further, even with Grok on its list.
    await sql`update public.agents set tools = ${sql.json({ agents: [agent.Grok, agent.Scout] })} where id = ${agent.Claude}`;
    const r = (await ask(t.runId, key)) as { sessionId: string };
    const c = await childRun(r.sessionId);
    expect(await runs.askAgent({ userId, runId: c.id, key: 'k', agent: 'Scout', question: 'q' })).toMatchObject({ error: expect.stringContaining('can’t ask a further agent') });
    expect(await runs.askableAgents(c, { agents: [agent.Grok, agent.Scout] })).toEqual([]);
    expect(await runs.askableAgents(await run(t.runId), { agents: [agent.Claude, agent.Scout, agent.Grok] })).toEqual([
      { name: 'Claude', brain: 'Claude Code', about: 'I am Claude.' },
      { name: 'Scout', brain: 'OpenAI', about: 'I am Scout.' },
    ]);
    await sql`update public.agents set tools = '{}'::jsonb where id = ${agent.Claude}`;
  });

  it('refuses when the asked agent’s computer is offline, and past the limits', async () => {
    const t = await askingTask();
    await sql`update public.devices set last_seen_at = now() - interval '10 minutes' where id = ${deviceId}`;
    expect(await ask(t.runId, await t.step())).toMatchObject({ error: expect.stringContaining('isn’t online right now') });
    await sql`update public.devices set last_seen_at = now() where id = ${deviceId}`;
    for (let i = 0; i < runs.MAX_ACTIVE_ASKS; i++) expect(await ask(t.runId, await t.step())).toHaveProperty('sessionId');
    expect(await ask(t.runId, await t.step())).toMatchObject({ error: expect.stringContaining('already answering') });
    await sql`update public.runs set status = 'completed' where trigger = 'agent' and user_id = ${userId}`;
    for (let i = runs.MAX_ACTIVE_ASKS; i < runs.MAX_ASKS_PER_RUN; i++) expect(await ask(t.runId, await t.step())).toHaveProperty('sessionId');
    expect(await ask(t.runId, await t.step())).toMatchObject({ error: expect.stringContaining('the most one task may') });
  });

  it('brings the answer back: the asker waits (busy, not needing the user) and is queued again when it comes', async () => {
    const t = await askingTask();
    const key = await t.step();
    const { sessionId } = (await ask(t.runId, key)) as { sessionId: string };
    await sql`update public.events set status = 'awaiting_agent' where id = ${key}`;
    expect(await runs.finishRun(t.runId, { kind: 'waiting_agent', steps: 1 })).toBe('paused');
    expect(await run(t.runId)).toMatchObject({ status: 'waiting' });
    expect((await sql`select status from public.sessions where id = ${t.sessionId}`)[0].status).toBe('running');
    expect(await runs.agentAnswer(userId, t.runId, key)).toEqual({ state: 'pending', agent: 'Claude' });

    const c = await childRun(sessionId);
    expect(await runs.finishRun(c.id, { kind: 'completed', result: 'Yes, ship it.', steps: 2 })).toBe('ended');
    expect(await run(t.runId)).toMatchObject({ status: 'queued' });
    expect(await runs.agentAnswer(userId, t.runId, key)).toEqual({ state: 'answered', agent: 'Claude', answer: 'Yes, ship it.' });
    // The answer goes to Grok, not to the user as "Claude finished".
    expect((await sql`select count(*)::int as n from public.notifications where user_id = ${userId} and kind = 'run_completed'`)[0].n).toBe(0);
  });

  it('catches an answer that came while the asker was still stopping', async () => {
    const t = await askingTask();
    const key = await t.step();
    const { sessionId } = (await ask(t.runId, key)) as { sessionId: string };
    await sql`update public.events set status = 'awaiting_agent' where id = ${key}`;
    // The asked agent finishes first: its wake-up finds the asker still running and leaves it.
    await runs.finishRun((await childRun(sessionId)).id, { kind: 'failed', error: 'no model', steps: 0 });
    expect(await run(t.runId)).toMatchObject({ status: 'running' });
    expect(await runs.finishRun(t.runId, { kind: 'waiting_agent', steps: 1 })).toBe('resumed');
    expect(await run(t.runId)).toMatchObject({ status: 'queued' });
    expect(await runs.agentAnswer(userId, t.runId, key)).toMatchObject({ state: 'failed', error: 'Claude couldn’t answer: no model.' });
  });

  it('keeps waiting for the user when the asker also waits for an approval', async () => {
    const t = await askingTask();
    const key = await t.step();
    const { sessionId } = (await ask(t.runId, key)) as { sessionId: string };
    await sql`update public.events set status = 'awaiting_agent' where id = ${key}`;
    await sql`update public.events set status = 'awaiting_approval' where id = ${await t.step()}`;
    await sql`update public.runs set status = 'waiting', lease_id = null, lease_until = null where id = ${t.runId}`;
    await runs.finishRun((await childRun(sessionId)).id, { kind: 'completed', result: 'ok', steps: 1 });
    expect(await run(t.runId)).toMatchObject({ status: 'waiting' });
  });

  it('stops the agents a task asked when it ends, saying why', async () => {
    const t = await askingTask();
    const { sessionId } = (await ask(t.runId, await t.step())) as { sessionId: string };
    expect(await runs.finishRun(t.runId, { kind: 'cancelled', steps: 1 })).toBe('ended');
    const c = await childRun(sessionId);
    expect(c.status).toBe('cancelled');
    const [note] = await sql`select data from public.events where run_id = ${c.id} and type = 'status'`;
    expect(note.data.text).toBe('Grok’s task ended, so it no longer needs this answer.');
  });

  it('stops the agent an engine stopped waiting for, saying why, and only that one', async () => {
    const t = await askingTask();
    const { sessionId } = (await ask(t.runId, 'engine:abc')) as { sessionId: string };
    const { sessionId: other } = (await ask(t.runId, 'engine:def', 'Claude', 'Another question?')) as { sessionId: string };
    await runs.cancelAsk(userId, t.runId, 'engine:abc');
    const c = await childRun(sessionId);
    expect(c.status).toBe('cancelled');
    const [note] = await sql`select data from public.events where run_id = ${c.id} and type = 'status'`;
    expect(note.data.text).toBe('Grok stopped waiting for this answer.');
    expect((await childRun(other)).status).not.toBe('cancelled');
    // Another account can't stop it.
    await runs.cancelAsk(randomUUID(), t.runId, 'engine:def');
    expect((await childRun(other)).status).not.toBe('cancelled');
  });

  it('cron: wakes an asker whose wake-up was missed, and stops asked agents that ran too long', async () => {
    const t = await askingTask();
    const key = await t.step();
    const { sessionId } = (await ask(t.runId, key)) as { sessionId: string };
    await sql`update public.events set status = 'awaiting_agent' where id = ${key}`;
    await sql`update public.runs set status = 'waiting', lease_id = null, lease_until = null where id = ${t.runId}`;
    // The answer is in, but the wake-up never happened (as if the server died between the two).
    await sql`update public.runs set status = 'completed', result = 'done', ended_at = now() - interval '1 minute' where session_id = ${sessionId}`;
    expect(await runs.tidyAsks()).toMatchObject({ woken: 1 });
    expect(await run(t.runId)).toMatchObject({ status: 'queued' });

    const t2 = await askingTask();
    const { sessionId: s2 } = (await ask(t2.runId, await t2.step())) as { sessionId: string };
    await sql`update public.runs set created_at = now() - make_interval(mins => ${runs.ASK_MINUTES + 1}) where session_id = ${s2}`;
    expect(await runs.tidyAsks()).toMatchObject({ stopped: 1 });
    expect((await childRun(s2)).status).toBe('cancelled');
  });
});
