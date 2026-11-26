import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 0.1.55 against a real Postgres with Wren's migrations: a secret card's answer (saved encrypted, the waiting run
// woken, the value blanked out of what the task saves afterwards), carrying a task on with another agent, and
// an agent's task for later. Runs only when WREN_TEST_DB names a local database (the local Supabase stack); a
// throwaway user is created and removed.
const URL = process.env.WREN_TEST_DB ?? '';
const local = /@(127\.0\.0\.1|localhost)[:/]/.test(URL);

vi.stubGlobal('fetch', async () => new Response('{}')); // pushes and kicks: nothing to reach in tests
const userId = randomUUID();
const otherUser = randomUUID();

describe.skipIf(!local)('secrets, hand-offs and tasks for later (database)', () => {
  let sql: postgres.Sql;
  let runs: typeof import('../src/lib/runs');
  let secrets: typeof import('../src/lib/task-secrets');
  let schedules: typeof import('../src/lib/schedules');
  let DbRunStore: typeof import('../src/lib/runner/store').DbRunStore;
  let claude = '';
  let scout = '';

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    process.env.WREN_SECRETS_KEY ??= randomBytes(32).toString('hex');
    sql = postgres(URL, { onnotice: () => {} });
    runs = await import('../src/lib/runs');
    secrets = await import('../src/lib/task-secrets');
    schedules = await import('../src/lib/schedules');
    DbRunStore = (await import('../src/lib/runner/store')).DbRunStore;
    for (const [id, tag] of [[userId, 'feat'], [otherUser, 'other']]) {
      await sql`insert into auth.users (id, email, aud, role) values (${id}, ${`${tag}-${id.slice(0, 8)}@example.test`}, 'authenticated', 'authenticated')`;
    }
    await sql`update public.profiles set timezone = 'Australia/Melbourne' where id = ${userId}`;
    const [d] = await sql`insert into public.devices (user_id, name, platform, last_seen_at) values (${userId}, 'Test Mac', 'darwin', now()) returning id`;
    const agent = async (name: string) =>
      (await sql`insert into public.agents (user_id, name, instructions, model, runtime, device_id, autonomy, tools)
        values (${userId}, ${name}, 'I help.', ${sql.json({ source: 'claude-code', model: 'default' })}, 'desktop', ${d.id}, 'balanced', '{}'::jsonb) returning id`)[0].id as string;
    claude = await agent('Claude');
    scout = await agent('Scout');
  });

  afterAll(async () => {
    if (!sql) return;
    for (const u of [userId, otherUser]) {
      await sql`delete from public.notifications where user_id = ${u}`;
      await sql`delete from public.schedules where user_id = ${u}`;
      await sql`delete from public.sessions where user_id = ${u}`;
      await sql`delete from public.agents where user_id = ${u}`;
      await sql`delete from public.devices where user_id = ${u}`;
      await sql`delete from auth.users where id = ${u}`;
    }
    await sql.end();
    const { db } = await import('../src/lib/db');
    await db().end();
  });

  beforeEach(async () => {
    await sql`delete from public.schedules where user_id = ${userId}`;
    await sql`delete from public.sessions where user_id = ${userId}`;
    await sql`delete from public.notifications where user_id = ${userId}`;
  });

  /** A task whose run a worker holds, with a store for it. */
  async function working(text = 'Deploy the site', agentId = claude) {
    const t = await runs.startTask({ userId, agentId, text });
    const lease = randomUUID();
    await sql`update public.runs set status = 'running', lease_id = ${lease}, lease_until = now() + interval '2 minutes' where id = ${t.runId}`;
    const store = new DbRunStore({ runId: t.runId, sessionId: t.sessionId, agentId, userId, agentName: 'Claude', source: 'claude-code', leaseId: lease });
    return { ...t, lease, store };
  }
  const runOf = async (id: string) => (await sql`select status, result, wake_at, pause_requested from public.runs where id = ${id}`)[0];

  it('a saved secret wakes the run, stays encrypted and is blanked out of what the task saves', async () => {
    const t = await working();
    const ask = await t.store.append('tool', { callId: 'c1', name: 'task.request_secret', args: { name: 'API_TOKEN', why: 'The deploy token.' }, title: 'Ask for a secret: API_TOKEN', risk: 'low' }, 'awaiting_secret');
    expect(await runs.finishRun(t.runId, { kind: 'waiting_input', question: 'Needs a secret: API_TOKEN', steps: 1 }, t.lease)).toBe('paused');
    expect((await runOf(t.runId)).status).toBe('waiting');

    // Someone else's account can't answer it, and a value too short is refused.
    await expect(secrets.answerSecret(otherUser, t.sessionId, ask.id, { value: 'tok_live_abcdef' })).rejects.toMatchObject({ status: 404 });
    await expect(secrets.answerSecret(userId, t.sessionId, ask.id, { value: 'ab' })).rejects.toMatchObject({ status: 400 });

    await secrets.answerSecret(userId, t.sessionId, ask.id, { value: '  tok_live_abcdef  ' });
    expect((await runOf(t.runId)).status).toBe('queued');
    const [ev] = await sql`select status, data from public.events where id = ${ask.id}`;
    expect(ev.data.secretAnswer).toBe('saved');
    const [row] = await sql`select ciphertext, expires_at from public.task_secrets where session_id = ${t.sessionId} and name = 'API_TOKEN'`;
    expect(row.ciphertext).not.toContain('tok_live');
    expect(new Date(row.expires_at).getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect(await secrets.loadTaskSecrets(t.sessionId, userId)).toEqual([{ name: 'API_TOKEN', value: 'tok_live_abcdef' }]);
    expect(await secrets.loadTaskSecrets(t.sessionId, otherUser)).toEqual([]);
    // Answered once only.
    await expect(secrets.answerSecret(userId, t.sessionId, ask.id, { decline: true })).rejects.toMatchObject({ status: 409 });

    // A worker carrying on: what commands print, and the final answer, never keep the value.
    const lease2 = randomUUID();
    await sql`update public.runs set status = 'running', lease_id = ${lease2}, lease_until = now() + interval '2 minutes' where id = ${t.runId}`;
    const store2 = new DbRunStore({ runId: t.runId, sessionId: t.sessionId, agentId: claude, userId, agentName: 'Claude', source: 'claude-code', leaseId: lease2 });
    const step = await store2.append('tool', { callId: 'c2', name: 'computer.shell', args: { command: 'echo $API_TOKEN' }, title: 'Run', risk: 'low' }, 'running');
    await store2.update(step.id, { status: 'done', data: { callId: 'c2', name: 'computer.shell', args: {}, title: 'Run', risk: 'low', result: { output: 'token is tok_live_abcdef\n' } } });
    const [saved] = await sql`select data from public.events where id = ${step.id}`;
    expect(saved.data.result.output).toBe('token is [secret API_TOKEN]\n');
    await runs.finishRun(t.runId, { kind: 'completed', result: 'Deployed with tok_live_abcdef', steps: 3 }, lease2);
    expect((await runOf(t.runId)).result).toBe('Deployed with [secret API_TOKEN]');
    const notes = await sql`select body from public.notifications where user_id = ${userId}`;
    expect(notes.map((n) => n.body).join(' ')).not.toContain('tok_live');

    await secrets.removeSecret(userId, t.sessionId, 'API_TOKEN');
    expect(await secrets.loadTaskSecrets(t.sessionId, userId)).toEqual([]);
  });

  it('a declined card, and a message instead of it, both wake the run', async () => {
    const t = await working();
    const ask = await t.store.append('tool', { callId: 'c1', name: 'task.request_secret', args: { name: 'API_TOKEN', why: 'x' }, title: 'Ask', risk: 'low' }, 'awaiting_secret');
    await runs.finishRun(t.runId, { kind: 'waiting_input', question: 'x', steps: 1 }, t.lease);
    await secrets.answerSecret(userId, t.sessionId, ask.id, { decline: true });
    expect((await runOf(t.runId)).status).toBe('queued');
    expect(await secrets.loadTaskSecrets(t.sessionId, userId)).toEqual([]);

    const u = await working('Second task');
    await u.store.append('tool', { callId: 'c1', name: 'task.request_secret', args: { name: 'API_TOKEN', why: 'x' }, title: 'Ask', risk: 'low' }, 'awaiting_secret');
    await runs.finishRun(u.runId, { kind: 'waiting_input', question: 'x', steps: 1 }, u.lease);
    await runs.startTask({ userId, agentId: claude, sessionId: u.sessionId, text: 'Use the mock instead' });
    expect((await runOf(u.runId)).status).toBe('queued');
  });

  it('a task carried on with another agent gets the conversation and files, and the old one stays paused', async () => {
    const t = await working('Fix the failing tests');
    await t.store.append('message', { role: 'assistant', text: 'The test needs Node 24.' }, 'done');
    await t.store.append('tool', { callId: 'c1', name: 'computer.shell', args: {}, title: 'Run `npm test`', risk: 'low', result: { output: 'x', isError: true } }, 'done');
    const [file] = await sql`insert into public.artifacts (user_id, agent_id, session_id, name, mime, size, blob_path, kind, source)
      values (${userId}, ${claude}, ${t.sessionId}, 'log.txt', 'text/plain', 12, 'u/x/log.txt', 'file', 'desktop') returning id`;
    await runs.finishRun(t.runId, { kind: 'paused', steps: 2, limit: { error: 'You’ve hit your limit', resetAt: Date.now() + 3_600_000 } }, t.lease);
    expect((await runOf(t.runId)).wake_at).not.toBeNull();

    await expect(runs.handOff(userId, t.sessionId, claude)).rejects.toMatchObject({ status: 400 });
    const next = await runs.handOff(userId, t.sessionId, scout);
    const [s] = await sql`select agent_id, handed_from from public.sessions where id = ${next.sessionId}`;
    expect(s).toMatchObject({ agent_id: scout, handed_from: t.sessionId });
    const [first] = await sql`select data from public.events where session_id = ${next.sessionId} and type = 'message' order by seq limit 1`;
    expect(first.data.text).toContain('Carry on with “Fix the failing tests”. Claude started it');
    expect(first.data.context).toContain('<earlier-conversation>');
    expect(first.data.context).toContain('User: Fix the failing tests');
    expect(first.data.context).toContain('Claude: The test needs Node 24.');
    expect(first.data.context).toContain('  - Run `npm test` (failed)');
    expect(first.data.attachments).toEqual([{ artifactId: file.id, name: 'log.txt', mime: 'text/plain', size: 12 }]);
    expect(await runOf(t.runId)).toMatchObject({ status: 'paused', wake_at: null, pause_requested: true });
    const [line] = await sql`select data from public.events where session_id = ${t.sessionId} and type = 'status' and data->>'code' = 'handed_off'`;
    expect(line.data).toMatchObject({ text: 'Carried on with Scout in a new task.', sessionId: next.sessionId });

    // Not while a task works.
    const busy = await working('Busy');
    await expect(runs.handOff(userId, busy.sessionId, scout)).rejects.toMatchObject({ status: 409 });
  });

  it('an agent’s task for later is set once, for that agent and task, at a time with an offset', async () => {
    const t = await working('Remind me tomorrow');
    const when = new Date(Date.now() + 26 * 3_600_000).toISOString().replace('Z', '+00:00');
    const a = await schedules.createReminder({ userId, agentId: claude, sessionId: t.sessionId, when, task: 'Remind the user to call the bank.', title: 'Call the bank' });
    expect(a).toMatchObject({ name: 'Call the bank', at: expect.stringContaining('(Australia/Melbourne)') });
    const again = await schedules.createReminder({ userId, agentId: claude, sessionId: t.sessionId, when, task: 'Remind the user to call the bank.', title: 'Call the bank' });
    expect(again).toMatchObject({ id: (a as { id: string }).id });
    const rows = await sql`select cron, run_at, next_run_at, enabled, source_session_id, agent_id from public.schedules where user_id = ${userId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cron: null, enabled: true, source_session_id: t.sessionId, agent_id: claude });
    expect(new Date(rows[0].run_at).getTime()).toBe(new Date(when).getTime());
    expect(new Date(rows[0].next_run_at).getTime()).toBe(new Date(when).getTime());
    expect(await schedules.createReminder({ userId, agentId: claude, sessionId: t.sessionId, when: '2026-11-27T17:00:00', task: 'x' })).toMatchObject({ error: expect.stringContaining('Australia/Melbourne') });
    expect(await schedules.createReminder({ userId, agentId: claude, sessionId: t.sessionId, when: new Date(Date.now() + 10_000).toISOString(), task: 'x' })).toMatchObject({ error: expect.stringContaining('a minute') });
    // The database keeps a schedule repeating or one-off, never both.
    await expect(sql`update public.schedules set cron = '0 8 * * *' where user_id = ${userId}`).rejects.toThrow(/schedules_when/);
  });
});
