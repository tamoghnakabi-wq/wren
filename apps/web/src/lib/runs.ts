import {
  DESKTOP_ONLY_SOURCES,
  runContext,
  type AgentAnswer,
  type AgentTools,
  type AskableAgent,
  type AskAgentStart,
  type Autonomy,
  type LoopOutcome,
  type MessageData,
  type ModelRef,
  type Runtime,
  type StatusData,
  type UsageLimit,
} from '@wren/core';
import type { TransactionSql } from 'postgres';
import { db, type Json } from './db';
import { env, selfUrl } from './env';
import { HttpError } from './auth';
import { assertPlatformAllowed } from './platform-credits';
import { notifyUser, nudgeDevice } from './notify';
import { SandboxHost } from './runner/sandbox-host';
import { sourceInfo } from './client/sources';

// Task lifecycle shared by the API routes, the cloud tick and the desktop API.

export const ACTIVE = ['queued', 'running', 'waiting', 'paused'] as const;

export interface StartTaskInput {
  userId: string;
  agentId: string;
  sessionId?: string;
  text: string;
  attachments?: { artifactId: string; name: string; mime: string; size: number }[];
  trigger?: 'user' | 'schedule' | 'agent';
  scheduleId?: string;
  scheduleName?: string;
  runtime?: Runtime; // override (e.g. "run this one in the cloud")
  deviceId?: string;
  /** A question another agent asked (task.ask_agent): the task is linked to the run that asked. */
  parent?: AskParent;
}

interface AskParent {
  runId: string;
  sessionId: string;
  /** Names this ask within the asking run: the same key finds the same task. */
  key: string;
  /** The asking worker's lease, checked when the task is created. */
  lease?: string;
  agentName: string;
  taskTitle: string;
  autonomy: Autonomy;
}

export async function startTask(i: StartTaskInput): Promise<{ sessionId: string; runId: string; continued: boolean }> {
  const sql = db();
  const [agent] = await sql`select * from public.agents where id = ${i.agentId} and user_id = ${i.userId} and archived_at is null`;
  if (!agent) throw new HttpError(404, 'Agent not found.', 'not_found');
  const text = i.text.trim().slice(0, 20000);
  if (!text && !i.attachments?.length) throw new HttpError(400, 'Say what the agent should do.', 'invalid');
  const imageRefs = (i.attachments ?? []).filter((a) => a.mime.startsWith('image/')).map((a) => ({ artifactId: a.artifactId, mime: a.mime }));
  const attachNote = i.attachments?.length ? `\n\n[Attached files: ${i.attachments.map((a) => a.name).join(', ')}]` : '';
  const userMessage = { role: 'user', text: text + attachNote, images: imageRefs, attachments: i.attachments ?? [] };

  // Continue the session's active run if it has one. Everything happens under a lock on the
  // session row, so two follow-ups sent at once can't each start a run, and a reply can't miss
  // a run that is switching to "waiting" (finishRun takes the run's lock and re-checks).
  if (i.sessionId) {
    const cont = await continueOrRestart(i.sessionId, i.userId, userMessage);
    if (cont) {
      if (cont.kick) await kickRun(cont.runId);
      return { sessionId: i.sessionId, runId: cont.runId, continued: true };
    }
  }

  const modelRef = agent.model as ModelRef;
  if (!modelRef?.source || !modelRef?.model) throw new HttpError(400, 'Choose a model for this agent first.', 'no_model');
  // Refused before a run exists, so a task (or schedule) on Wren credits never queues while they're off.
  if (modelRef.source === 'platform') {
    const [owner] = await sql`select email from public.profiles where id = ${i.userId}`;
    assertPlatformAllowed({ email: owner?.email ?? '' });
  }
  let runtime: Runtime = i.runtime ?? agent.runtime;
  if (DESKTOP_ONLY_SOURCES.includes(modelRef.source) && modelRef.source !== 'chatgpt') runtime = 'desktop';
  let deviceId: string | null = null;
  let device: { id: string; name: string; platform: string; policy: Record<string, unknown>; last_seen_at: Date | null } | undefined;
  if (runtime === 'desktop') {
    const wanted = i.deviceId ?? agent.device_id;
    const rows = wanted
      ? await sql`select id, name, platform, policy, last_seen_at from public.devices where id = ${wanted} and user_id = ${i.userId} and revoked_at is null`
      : await sql`select id, name, platform, policy, last_seen_at from public.devices where user_id = ${i.userId} and revoked_at is null order by last_seen_at desc nulls last limit 1`;
    if (!rows.length && wanted) throw new HttpError(400, 'The computer this agent uses isn’t linked any more. Choose another computer in the agent’s settings, or link it again from the desktop app.', 'no_device');
    if (!rows.length) throw new HttpError(400, 'This agent runs on your computer, but no desktop app is linked. Install Wren for Mac or Windows and link it.', 'no_device');
    device = rows[0] as typeof device;
    deviceId = device!.id;
    // An agent asking would wait for an answer that can't come while the computer is off.
    if (i.parent && !(device!.last_seen_at && Date.now() - new Date(device!.last_seen_at).getTime() < 3 * 60_000)) {
      throw new HttpError(409, `${agent.name} works on ${device!.name}, which isn’t online right now, so it can’t answer. Carry on without it, or tell the user.`, 'device_offline');
    }
  }

  const [profile] = await sql`select timezone from public.profiles where id = ${i.userId}`;
  const memories = agent.memory_enabled ? await sql`select id, content from public.agent_memories where agent_id = ${agent.id} order by created_at` : [];
  const context = runContext({
    now: new Date(),
    timezone: profile?.timezone ?? 'UTC',
    runtime,
    deviceName: device?.name,
    platform: device?.platform,
    allowedFolders: (device?.policy?.folders as string[] | undefined) ?? undefined,
    memories: memories.map((m) => ({ id: String(m.id), content: m.content })),
    trigger: i.trigger ?? 'user',
    scheduleName: i.scheduleName,
    askedBy: i.parent ? { agent: i.parent.agentName, task: i.parent.taskTitle } : undefined,
  });
  const msg: MessageData & { context: string } = { ...(userMessage as MessageData), context };

  // Session (if new), run, first message and session state are created together.
  const created = await taskTx(async (tx) => {
    // Removing the agent takes this row's lock first, so a task is never created for an agent being
    // removed, and one created first is seen (and cancelled) by the removal (W-158).
    const [live] = await tx`select id from public.agents where id = ${agent.id} and archived_at is null for share`;
    if (!live) throw new HttpError(404, 'Agent not found.', 'not_found');
    if (deviceId) {
      // Unlinking takes this row's lock first, so a run is never created for a computer being unlinked (W-147).
      const [linked] = await tx`select id from public.devices where id = ${deviceId} and revoked_at is null for share`;
      if (!linked) throw new HttpError(400, 'That computer was unlinked. Link it again in the desktop app, or choose another.', 'no_device');
    }
    if (i.parent) {
      // Under the asking task's lock: asks from one run are counted (and found again) one at a time.
      const p = i.parent;
      await tx`select id from public.sessions where id = ${p.sessionId} for no key update`;
      const [asker] = await tx`select status, cancel_requested, lease_id from public.runs where id = ${p.runId}`;
      if (!asker || !(ACTIVE as readonly string[]).includes(asker.status) || asker.cancel_requested) throw new HttpError(409, 'The task that asked has ended.', 'conflict');
      if (p.lease && asker.lease_id !== p.lease) throw new HttpError(409, 'This worker no longer holds this run.', 'lease_lost');
      const [same] = await tx`select id from public.sessions where parent_run_id = ${p.runId} and parent_ask_key = ${p.key}`;
      if (same) return { sessionId: same.id as string, runId: null as string | null };
      const [{ n }] = await tx`select count(*)::int as n from public.sessions where parent_run_id = ${p.runId}`;
      if (n >= MAX_ASKS_PER_RUN) throw new HttpError(429, `This task has already asked other agents ${MAX_ASKS_PER_RUN} times, the most one task may. Carry on with what you have.`, 'ask_limit');
      const [{ m }] = await tx`select count(*)::int as m from public.runs where user_id = ${i.userId} and trigger = 'agent' and status in ('queued', 'running', 'waiting', 'paused')`;
      if (m >= MAX_ACTIVE_ASKS) throw new HttpError(429, `${m} agents are already answering other agents' questions. Wait for an answer, then ask again.`, 'ask_busy');
    }
    let sessionId = i.sessionId;
    if (sessionId) {
      const [session] = await tx`select id from public.sessions where id = ${sessionId} and user_id = ${i.userId} for no key update`;
      if (!session) throw new HttpError(404, 'Task not found.', 'not_found');
      // Someone else started a run while we were preparing: join it instead.
      const [active] = await tx`select id from public.runs where session_id = ${sessionId} and status in ('queued', 'running', 'waiting', 'paused') limit 1`;
      if (active) return { sessionId, runId: null as string | null };
    } else {
      const title = (text.split('\n')[0] || 'New task').slice(0, 80);
      const [s] = await tx`insert into public.sessions (user_id, agent_id, title, status, runtime, device_id, parent_session_id, parent_run_id, parent_ask_key)
        values (${i.userId}, ${agent.id}, ${title}, 'queued', ${runtime}, ${deviceId}, ${i.parent?.sessionId ?? null}, ${i.parent?.runId ?? null}, ${i.parent?.key ?? null}) returning id`;
      sessionId = s.id as string;
    }
    const [run] = await tx`
      insert into public.runs (user_id, agent_id, session_id, status, runtime, device_id, trigger, schedule_id, model, autonomy_cap)
      values (${i.userId}, ${agent.id}, ${sessionId!}, 'queued', ${runtime}, ${deviceId}, ${i.parent ? 'agent' : (i.trigger ?? 'user')}, ${i.scheduleId ?? null}, ${tx.json(modelRef as unknown as Json)}, ${i.parent?.autonomy ?? null})
      returning id`;
    await tx`insert into public.events (user_id, session_id, run_id, type, status, data) values (${i.userId}, ${sessionId!}, ${run.id}, 'message', 'done', ${tx.json(msg as unknown as Json)})`;
    await tx`update public.sessions set status = 'queued', runtime = ${runtime}, device_id = ${deviceId}, last_event_at = now() where id = ${sessionId!}`;
    return { sessionId: sessionId!, runId: run.id as string };
  });
  // After commit: the transaction only share-locks the agent (two tasks for it at once mustn't
  // deadlock upgrading that lock, W-160).
  if (created.runId) await sql`update public.agents set last_active_at = now() where id = ${agent.id}`.catch(() => {});
  if (!created.runId && i.parent) return { sessionId: created.sessionId, runId: '', continued: true }; // asked already: the same task
  if (!created.runId) {
    const cont = await continueOrRestart(created.sessionId, i.userId, userMessage);
    if (!cont) throw new HttpError(409, 'The task changed while sending; try again.', 'conflict');
    if (cont.kick) await kickRun(cont.runId);
    return { sessionId: created.sessionId, runId: cont.runId, continued: true };
  }
  await kickRun(created.runId);
  return { sessionId: created.sessionId, runId: created.runId, continued: false };
}

/**
 * Continue the session's active run; but a desktop run whose computer was unlinked is ended first, so
 * this message starts a new run instead of joining one nothing can run (W-147). Decided under the session's
 * lock, together with adding the message.
 */
async function continueOrRestart(sessionId: string, userId: string, message: Record<string, unknown>): Promise<{ runId: string; kick: boolean } | null> {
  for (let i = 0; i < 3; i++) {
    const cont = await continueActiveRun(sessionId, userId, message);
    if (!cont || !('orphan' in cont)) return cont;
    await finishRun(cont.orphan, { kind: 'cancelled', steps: 0 }, undefined, { orphaned: true });
  }
  throw new HttpError(409, 'The task changed while sending; try again.', 'conflict');
}

/** Add a user message to the session's active run, resuming it if it was paused or waiting for this answer. */
async function continueActiveRun(sessionId: string, userId: string, message: Record<string, unknown>): Promise<{ runId: string; kick: boolean } | { orphan: string } | null> {
  return taskTx(async (tx) => {
    const [session] = await tx`select id from public.sessions where id = ${sessionId} and user_id = ${userId} for no key update`;
    if (!session) throw new HttpError(404, 'Task not found.', 'not_found');
    const [removed] = await tx`select 1 from public.sessions s join public.agents a on a.id = s.agent_id where s.id = ${sessionId} and a.archived_at is not null`;
    if (removed) throw new HttpError(404, 'Agent not found.', 'not_found'); // removed: its tasks take no more messages (W-158)
    const [active] = await tx`select r.id, r.status, r.runtime, r.device_id, (r.runtime = 'desktop' and d.revoked_at is not null) as orphaned,
        (r.status = 'paused' and not r.pause_requested and r.wake_at is not null and r.wake_at > now()) as limited
      from public.runs r left join public.devices d on d.id = r.device_id
      where r.session_id = ${sessionId} and r.status in ('queued', 'running', 'waiting', 'paused') order by r.created_at desc limit 1 for no key update of r`;
    if (!active) return null;
    if (active.orphaned) return { orphan: active.id as string };
    if (active.device_id) {
      // Held until this message is in, so an unlink waits for it (and then ends the run with it) rather
      // than landing between the check above and the insert (W-147).
      const [stillLinked] = await tx`select id from public.devices where id = ${active.device_id} and revoked_at is null for share`;
      if (!stillLinked && active.runtime === 'desktop') return { orphan: active.id as string };
    }
    await tx`insert into public.events (user_id, session_id, run_id, type, status, data)
      values (${userId}, ${sessionId}, ${active.id}, 'message', 'done', ${tx.json(message as unknown as Json)})`;
    await tx`update public.sessions set last_event_at = now() where id = ${sessionId}`;
    // Waiting out a plan's usage limit: sending now would only hit it again, so the message goes when the
    // task carries on (at the reset, or when the user presses Resume now).
    if (active.limited) return { runId: active.id as string, kick: false };
    const [asked] = await tx`select 1 from public.events where run_id = ${active.id} and type = 'tool' and status = 'awaiting_input' limit 1`;
    if (active.status === 'paused' || (active.status === 'waiting' && asked)) {
      await tx`update public.runs set status = 'queued', pause_requested = false, wake_at = null where id = ${active.id}`;
      await tx`update public.sessions set status = 'queued' where id = ${sessionId}`;
      return { runId: active.id as string, kick: true };
    }
    // Still running: its worker (or finishRun, which checks for a reply) will pick the message up.
    return { runId: active.id as string, kick: false };
  });
}

/** Start or wake whatever executes this run. */
export async function kickRun(runId: string): Promise<void> {
  const [run] = await db()`select runtime, device_id from public.runs where id = ${runId}`;
  if (!run) return;
  if (run.runtime === 'desktop') {
    if (run.device_id) await nudgeDevice(run.device_id, 'run');
  } else {
    await kickTick(runId);
  }
}

export async function kickTick(runId: string): Promise<void> {
  try {
    const res = await fetch(`${selfUrl()}/api/internal/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wren-internal': env.internalSecret, ...bypassHeader() },
      body: JSON.stringify({ runId }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.warn('kickTick status', res.status);
  } catch (e) {
    // The watchdog cron will pick the run up within a minute.
    console.warn('kickTick failed', (e as Error).message);
  }
}

function bypassHeader(): Record<string, string> {
  const b = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return b ? { 'x-vercel-protection-bypass': b } : {};
}

/**
 * A transaction over a task's rows. Every one locks the session row first, then the run row
 * (FOR NO KEY UPDATE: it doesn't block a worker's event inserts), so two of them can't wait on
 * each other. A deadlock or serialization abort, which the database resolves by cancelling one
 * side, is retried.
 */
export async function taskTx<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await db().begin(fn)) as T;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if ((code === '40P01' || code === '40001') && attempt < 4) {
        await new Promise((r) => setTimeout(r, 30 * attempt + Math.random() * 50));
        continue;
      }
      throw e;
    }
  }
}

const terminalKind = (k: LoopOutcome['kind']) => k === 'completed' || k === 'failed' || k === 'cancelled';

const SESSION_STATUS: Record<LoopOutcome['kind'], string> = {
  completed: 'completed',
  waiting_approval: 'waiting',
  waiting_input: 'waiting',
  // Not waiting for the user: the task is busy, through the agent it asked.
  waiting_agent: 'running',
  yield: 'running',
  cancelled: 'cancelled',
  paused: 'paused',
  failed: 'failed',
};

/**
 * Persist a terminal or waiting outcome for a run (cloud or desktop). With a
 * lease id, only the worker that still holds the lease can finish the run.
 * Runs under the run row's lock: an approval decided, or a question answered,
 * while the worker was stopping is seen here and the run is queued again
 * instead of being left waiting (decideApproval / continueActiveRun take the
 * same lock after writing their side).
 */
/**
 * How finishing went: `ended` (the run is completed/failed/cancelled now), `resumed` (more input
 * arrived, so it was queued again), `paused` (waiting, or handed back to run more), `lease_lost`
 * (another worker owns it: nothing was written) or `missing`.
 */
export type FinishResult = 'ended' | 'resumed' | 'paused' | 'lease_lost' | 'missing';

/**
 * `idle`: finish only a run nothing is executing (Stop). `orphaned`: finish a run whose computer was unlinked,
 * whoever holds its lease (only that computer could, and it can't report any more, W-147).
 */
export async function finishRun(runId: string, outcome: LoopOutcome, leaseId?: string, opts: { idle?: boolean; orphaned?: boolean } = {}): Promise<FinishResult> {
  const sql = db();
  const [ref] = await sql`select session_id from public.runs where id = ${runId}`;
  if (!ref) return 'missing';
  const done = await taskTx(async (tx) => {
    await tx`select id from public.sessions where id = ${ref.session_id} for no key update`;
    const [run] = await tx`select r.*, (r.lease_until is not null and r.lease_until > now()) as leased, a.name as agent_name, s.title
      from public.runs r join public.agents a on a.id = r.agent_id join public.sessions s on s.id = r.session_id where r.id = ${runId} for no key update of r`;
    if (!run) return 'missing' as const;
    if (leaseId && run.lease_id !== leaseId) return 'lease_lost' as const; // another worker owns the run now
    if (opts.idle || opts.orphaned) {
      // Finishing a run nothing was executing (Stop): as it is now, under the lock, not as it was
      // when that was decided. A worker that claimed it meanwhile sees the request and ends it itself;
      // one that finished it meanwhile has said how it ended (W-115).
      if (!(ACTIVE as readonly string[]).includes(run.status)) return 'ended' as const;
      if (opts.idle && run.leased) return 'lease_lost' as const;
    }
    if (opts.orphaned) {
      const [unlinked] = await tx`select id from public.devices where id = ${run.device_id} and revoked_at is not null`;
      if (run.runtime !== 'desktop' || !unlinked) return 'lease_lost' as const;
      await tx`insert into public.events (user_id, session_id, run_id, type, status, data)
        values (${run.user_id}, ${run.session_id}, ${runId}, 'status', 'done', ${tx.json({ text: 'The computer this task was using was unlinked, so the task stopped.', level: 'warn' } satisfies StatusData as unknown as Json)})`;
    }
    let o = outcome;
    // Stop was pressed while the worker was busy: whatever it reports next, the run ends cancelled.
    const cancelledLate = run.cancel_requested && !['completed', 'failed', 'cancelled'].includes(o.kind);
    if (cancelledLate) o = { kind: 'cancelled', steps: o.steps };
    let runStatus = o.kind === 'waiting_approval' || o.kind === 'waiting_input' || o.kind === 'waiting_agent' ? 'waiting' : o.kind === 'yield' ? 'running' : o.kind;
    // A plan's usage limit (not the user's Pause): the task waits for the reset, and carries on by itself
    // then when the account allows it (`limitWake`). What a computer reports is checked, not trusted.
    const limit = o.kind === 'paused' ? cleanLimit(o.limit) : undefined;
    let wakeAt: Date | null = null;
    let zone = 'UTC';
    if (limit) {
      const [p] = await tx`select settings, timezone from public.profiles where id = ${run.user_id}`;
      const [{ n }] = await tx`select count(*)::int as n from public.events where run_id = ${runId} and type = 'status' and data->>'code' = 'usage_limit'`;
      zone = String(p?.timezone || 'UTC');
      wakeAt = limitWake(limit.resetAt, { enabled: (p?.settings as { resumeAfterLimits?: unknown } | undefined)?.resumeAfterLimits !== false, userPaused: !!run.pause_requested, earlier: Number(n) });
    }
    let resume = false;
    if (o.kind === 'waiting_approval') {
      const [a] = await tx`select status from public.approvals where id = ${o.approvalId} and run_id = ${runId}`;
      resume = !!a && ['approved', 'denied', 'expired'].includes(a.status);
    } else if (o.kind === 'waiting_input') {
      const [answered] = await tx`
        select 1 from public.events m where m.run_id = ${runId} and m.type = 'message' and m.data->>'role' = 'user'
          and m.seq > (select coalesce(max(seq), 0) from public.events where run_id = ${runId} and type = 'tool' and status = 'awaiting_input')
        limit 1`;
      resume = !!answered;
    } else if (o.kind === 'waiting_agent') {
      // An agent that answered while this run was stopping: its wake-up found the run still running.
      const [answered] = await tx`
        select 1 from public.events e
          join public.sessions s on s.parent_run_id = e.run_id and s.parent_ask_key = e.id::text
          join public.runs c on c.session_id = s.id and c.trigger = 'agent'
        where e.run_id = ${runId} and e.type = 'tool' and e.status = 'awaiting_agent' and c.status in ('completed', 'failed', 'cancelled')
        limit 1`;
      resume = !!answered;
    } else if (o.kind === 'completed' && typeof o.seenSeq === 'number') {
      // A message the final answer never saw (sent while it was being written): keep going.
      const [late] = await tx`
        select 1 from public.events where run_id = ${runId} and type = 'message' and data->>'role' = 'user' and seq > ${o.seenSeq} limit 1`;
      resume = !!late;
    }
    if (resume) runStatus = 'queued';
    const terminal = ['completed', 'failed', 'cancelled'].includes(runStatus);
    await tx`
      update public.runs set status = ${runStatus}, step = greatest(step, ${o.steps}), lease_id = null, lease_until = null,
        retry_count = case when ${o.steps} > step then 0 else retry_count end,
        error = ${o.kind === 'failed' ? o.error : null},
        result = ${o.kind === 'completed' ? o.result.slice(0, 20000) : run.result},
        ended_at = ${terminal ? new Date() : null},
        cleanup_pending = cleanup_pending or ${terminal && run.runtime === 'cloud'},
        wake_at = ${runStatus === 'paused' ? wakeAt : null}
      where id = ${runId}`;
    if (o.kind === 'cancelled') {
      // Steps and approvals the run never finished end with it.
      await tx`update public.events set status = 'cancelled' where run_id = ${runId} and type = 'tool' and status in ('pending', 'awaiting_approval', 'awaiting_input', 'awaiting_agent', 'running')`;
      await tx`update public.approvals set status = 'cancelled' where run_id = ${runId} and status = 'pending'`;
    }
    await tx`update public.sessions set status = ${resume ? 'queued' : SESSION_STATUS[o.kind]}, last_event_at = now() where id = ${run.session_id}`;
    if (terminal) await tx`delete from public.run_live where run_id = ${runId}`;
    if (o.kind === 'failed') {
      await tx`insert into public.events (user_id, session_id, run_id, type, status, data)
        values (${run.user_id}, ${run.session_id}, ${runId}, 'status', 'done', ${tx.json({ text: o.error, level: 'error', ...(o.code ? { code: o.code } : {}) } satisfies StatusData as unknown as Json)})`;
    }
    if (limit) {
      const line: LimitStatus = { text: limit.error, level: 'warn', code: 'usage_limit', ...(limit.code ? { cause: limit.code } : {}), ...(limit.resetAt ? { resetAt: limit.resetAt } : {}), ...(wakeAt ? { wakeAt: wakeAt.getTime() } : {}) };
      await tx`insert into public.events (user_id, session_id, run_id, type, status, data)
        values (${run.user_id}, ${run.session_id}, ${runId}, 'status', 'done', ${tx.json(line as unknown as Json)})`;
    }
    return { run, o, resume, terminal, limit, wakeAt, zone };
  });
  if (typeof done === 'string') return done;
  const { run, o, resume, terminal, limit, wakeAt, zone } = done;
  if (resume) await kickRun(runId);
  if (terminal && !resume) {
    // An asked agent's answer is in: the agent that asked carries on. Agents this run asked stop with it.
    if (run.trigger === 'agent') await wakeAsker(run.session_id).catch((e) => console.warn('wakeAsker failed', (e as Error).message));
    await stopAsks(run.user_id, runId, run.agent_name).catch((e) => console.warn('stopAsks failed', (e as Error).message));
  }
  // A finished run's shell jobs (background ones included) and browser tab end with it. The
  // flag set above stays until the VM confirms it, and the cron retries until then.
  if (terminalKind(o.kind) && !resume && run.runtime === 'cloud') await cleanUpCloudRun(run.agent_id, runId);

  const url = `/app/s/${run.session_id}`;
  if (o.kind === 'failed') {
    await notifyUser({ userId: run.user_id, kind: 'run_failed', title: `${run.agent_name} couldn't finish`, body: `${run.title}: ${o.error}`.slice(0, 300), url, sessionId: run.session_id });
  } else if (o.kind === 'completed' && run.trigger !== 'agent') {
    // An asked agent's answer goes to the agent that asked, which reports to the user.
    await notifyUser({ userId: run.user_id, kind: 'run_completed', title: `${run.agent_name} finished`, body: (o.result || run.title).replace(/[#*_`>]/g, '').slice(0, 280), url, sessionId: run.session_id });
  } else if (limit) {
    const reset = limit.resetAt ? ` It resets ${formatWhen(limit.resetAt, zone)}.` : '';
    await notifyUser({
      userId: run.user_id,
      kind: 'run_limited',
      title: `${run.agent_name} hit a usage limit`,
      body: `${run.title}: ${wakeAt ? `it carries on ${formatWhen(wakeAt.getTime(), zone)}, once the limit resets.` : `paused.${reset} Resume it when you're ready.`}`.slice(0, 300),
      url,
      sessionId: run.session_id,
    });
  }
  // waiting_input: the question notification is sent by the loop's ask_user handler
  return resume ? 'resumed' : terminal ? 'ended' : 'paused';
}

/** Stop a finished cloud run's commands and close its browser tab; clears the pending flag once confirmed. */
export async function cleanUpCloudRun(agentId: string, runId: string): Promise<boolean> {
  const ok = await SandboxHost.endRun(agentId, runId);
  if (ok) await db()`update public.runs set cleanup_pending = false where id = ${runId}`;
  return ok;
}

/** Approve or deny a pending approval; resumes the run. */
export async function decideApproval(userId: string, approvalId: string, approve: boolean, via: string, note?: string): Promise<{ runId: string; status: string }> {
  const sql = db();
  const [pre] = await sql`select detail from public.approvals where id = ${approvalId} and user_id = ${userId}`;
  if (pre?.detail?.localOnly && via !== 'desktop') {
    throw new HttpError(403, 'This computer only accepts approvals made on it (remote approvals are turned off in its Wren settings).', 'local_only');
  }
  const [a] = await sql`select run_id, session_id from public.approvals where id = ${approvalId} and user_id = ${userId}`;
  if (!a) throw new HttpError(404, 'Approval not found.', 'not_found');
  // Same lock order as finishRun: if the worker is switching the run to "waiting", this waits
  // and then sees "waiting"; if it hasn't started yet, finishRun sees the decision instead.
  const r = await taskTx(async (tx) => {
    await tx`select id from public.sessions where id = ${a.session_id} for no key update`;
    await tx`select id from public.runs where id = ${a.run_id} for no key update`;
    const rows = await tx`
      update public.approvals set status = ${approve ? 'approved' : 'denied'}, decided_at = now(), decided_via = ${via}, note = ${note ?? null}
      where id = ${approvalId} and user_id = ${userId} and status = 'pending' and expires_at > now() and not (coalesce(detail->>'localOnly', 'false') = 'true' and ${via} <> 'desktop')
      returning id`;
    if (!rows.length) {
      const [now] = await tx`select status, detail from public.approvals where id = ${approvalId}`;
      if (now?.status === 'pending' && now.detail?.localOnly && via !== 'desktop') throw new HttpError(403, 'This computer only accepts approvals made on it (remote approvals are turned off in its Wren settings).', 'local_only');
      return { status: now?.status as string, kick: false };
    }
    const [run] = await tx`update public.runs set status = 'queued' where id = ${a.run_id} and status = 'waiting' returning id`;
    if (run) await tx`update public.sessions set status = 'queued' where id = ${a.session_id}`;
    return { status: approve ? 'approved' : 'denied', kick: !!run };
  });
  if (r.kick) await kickRun(a.run_id);
  return { runId: a.run_id, status: r.status };
}

/**
 * Stop a run. True when it ended here and now; false when the worker running it still has to notice.
 * The request and the decision are made under the task's locks (session, then run) and checked again
 * when finishing, so a worker claiming or finishing the run at the same moment is never overwritten
 * (W-115).
 */
export async function cancelRun(userId: string, runId: string): Promise<boolean> {
  const [ref] = await db()`select session_id from public.runs where id = ${runId} and user_id = ${userId}`;
  if (!ref) return true;
  const run = await taskTx(async (tx) => {
    await tx`select id from public.sessions where id = ${ref.session_id} for no key update`;
    const [r] = await tx`update public.runs set cancel_requested = true
      where id = ${runId} and user_id = ${userId} and status in ('queued', 'running', 'waiting', 'paused')
      returning runtime, agent_id, (lease_until is not null and lease_until > now()) as leased`;
    if (r) await tx`update public.approvals set status = 'cancelled' where run_id = ${runId} and status = 'pending'`;
    return r;
  });
  if (!run) return true;
  let ended = false;
  if (!run.leased) {
    // Nothing is executing it: finish it here (unless a worker has claimed it since).
    ended = (await finishRun(runId, { kind: 'cancelled', steps: 0 }, undefined, { idle: true })) === 'ended';
  } else if (run.runtime === 'cloud') {
    // A tick is mid-step: end the run's commands now so it notices Stop without waiting them out.
    await SandboxHost.endRun(run.agent_id, runId);
  }
  if (run.runtime === 'desktop') await kickRun(runId);
  return ended;
}

/** Pause a run. True when it paused here and now; false when it pauses after the current step. Locked like cancelRun. */
export async function pauseRun(userId: string, runId: string): Promise<boolean> {
  const [ref] = await db()`select session_id from public.runs where id = ${runId} and user_id = ${userId}`;
  if (!ref) return true;
  const r = await taskTx(async (tx) => {
    await tx`select id from public.sessions where id = ${ref.session_id} for no key update`;
    const [run] = await tx`update public.runs set pause_requested = true
      where id = ${runId} and user_id = ${userId} and status in ('queued', 'running')
      returning runtime, (lease_until is not null and lease_until > now()) as leased`;
    if (!run) return null;
    // A worker holds it: it pauses after the current step. Otherwise nothing is executing it.
    if (run.leased) return { runtime: run.runtime as string, paused: false };
    await tx`update public.runs set status = 'paused', wake_at = null where id = ${runId}`;
    await tx`update public.sessions set status = 'paused' where id = ${ref.session_id}`;
    return { runtime: run.runtime as string, paused: true };
  });
  if (!r) return true;
  if (r.runtime === 'desktop') await kickRun(runId);
  return r.paused;
}

/**
 * End the unfinished tasks of removed agents (cron): every one is marked to stop, and one nothing holds is
 * ended now. A backstop for removal steps that failed or were cut short (W-163). How many it ended.
 */
export async function endRemovedAgentRuns(until = Infinity): Promise<number> {
  const sql = db();
  await sql`update public.runs set cancel_requested = true
    where status in ('queued', 'running', 'waiting', 'paused') and not cancel_requested
      and agent_id in (select id from public.agents where archived_at is not null)`;
  const idle = await sql`
    select r.id from public.runs r join public.agents a on a.id = r.agent_id
    where a.archived_at is not null and r.status in ('queued', 'running', 'waiting', 'paused')
      and (r.lease_until is null or r.lease_until < now())
    order by r.created_at limit 50`;
  let ended = 0;
  for (const r of idle) {
    if (Date.now() > until) break; // the cron's time is up (a cloud run's finish cleans up its computer)
    try {
      if ((await finishRun(r.id, { kind: 'cancelled', steps: 0 }, undefined, { idle: true })) === 'ended') ended++;
    } catch (e) {
      console.error(`[wren] ending removed agent's run ${r.id}: ${(e as Error).message}`);
    }
  }
  return ended;
}

export async function resumeRun(userId: string, runId: string) {
  const [ref] = await db()`select session_id from public.runs where id = ${runId} and user_id = ${userId}`;
  if (!ref) return;
  const resumed = await taskTx(async (tx) => {
    await tx`select id from public.sessions where id = ${ref.session_id} for no key update`;
    // Not a removed agent's task (W-158).
    const [run] = await tx`update public.runs set pause_requested = false, status = 'queued', wake_at = null
      where id = ${runId} and user_id = ${userId} and status = 'paused'
        and exists (select 1 from public.agents a where a.id = runs.agent_id and a.archived_at is null) returning id`;
    if (run) await tx`update public.sessions set status = 'queued' where id = ${ref.session_id}`;
    return !!run;
  });
  if (resumed) await kickRun(runId);
}

/**
 * "Don't resume": a task paused by a usage limit stays paused at the reset, as if the user had paused it
 * (`pause_requested`, which the cron's `limits` stage skips). Resume still carries it on.
 */
export async function holdRun(userId: string, runId: string): Promise<void> {
  const [ref] = await db()`select session_id from public.runs where id = ${runId} and user_id = ${userId}`;
  if (!ref) return;
  await taskTx(async (tx) => {
    await tx`select id from public.sessions where id = ${ref.session_id} for no key update`;
    await tx`update public.runs set wake_at = null, pause_requested = true where id = ${runId} and user_id = ${userId} and status = 'paused'`;
  });
}

// ---------------------------------------------------------------- usage limits

/** How many times one run carries on by itself after a usage limit; after that it waits for the user. */
export const MAX_LIMIT_RESUMES = 3;
/** A reset further away than this (a weekly limit) waits for the user: the task would act on old intent. */
export const LIMIT_HORIZON_MS = 24 * 3_600_000;

/** A usage-limit status line in the timeline (`code: 'usage_limit'`). */
export type LimitStatus = StatusData & { cause?: string; resetAt?: number; wakeAt?: number };

/** A limit as a computer reported it, checked: text clipped, the reset a time within the next 8 days. */
export function cleanLimit(l: unknown): UsageLimit | undefined {
  if (!l || typeof l !== 'object') return undefined;
  const v = l as Record<string, unknown>;
  const reset = Number(v.resetAt);
  const now = Date.now();
  return {
    error: String(v.error ?? '').slice(0, 1500) || 'A usage limit was reached.',
    ...(typeof v.code === 'string' ? { code: v.code.slice(0, 80) } : {}),
    ...(Number.isFinite(reset) && reset > now - 3_600_000 && reset < now + 8 * 86_400_000 ? { resetAt: Math.round(reset) } : {}),
    ...(v.midTurn === true ? { midTurn: true } : {}),
  };
}

/**
 * When a task paused by a usage limit carries on by itself: a minute after the reset (at least five minutes
 * from now, plus up to a minute so tasks paused together don't all start at once), or never (null) when the
 * account turned it off, the user paused the task, the reset is unknown or more than a day away, or this run
 * already carried on MAX_LIMIT_RESUMES times.
 */
export function limitWake(resetAt: number | undefined, o: { enabled: boolean; userPaused: boolean; earlier: number; now?: number; jitter?: number }): Date | null {
  const now = o.now ?? Date.now();
  if (!o.enabled || o.userPaused || !resetAt || o.earlier >= MAX_LIMIT_RESUMES || resetAt - now > LIMIT_HORIZON_MS) return null;
  const jitter = o.jitter ?? Math.floor(Math.random() * 60_000);
  return new Date(Math.max(resetAt + 60_000, now + 5 * 60_000) + jitter);
}

/** "at 3:40 pm" today, "tomorrow at 9:00 am", else "on Tue 18 Nov at 9:00 am", in the account's time zone. */
export function formatWhen(ms: number, zone: string, now = Date.now()): string {
  const tz = (() => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return zone;
    } catch {
      return 'UTC';
    }
  })();
  const day = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
  const time = new Intl.DateTimeFormat('en', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(ms).toLowerCase().replace(/\s+/g, ' ');
  if (day(ms) === day(now)) return `at ${time}`;
  if (day(ms) === day(now + 86_400_000)) return `tomorrow at ${time}`;
  return `on ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(ms)} at ${time}`;
}

/**
 * The cron's `limits` stage: tasks paused by a usage limit whose reset has come carry on. The account's
 * setting is read again now (turned off meanwhile: the task just stays paused for the user). Runs of removed
 * agents are left to endRemovedAgentRuns. How many carried on.
 */
export async function resumeLimitedRuns(until = Infinity): Promise<number> {
  const due = await db()`
    select r.id, r.session_id, (p.settings->'resumeAfterLimits') is distinct from 'false'::jsonb as enabled
    from public.runs r join public.profiles p on p.id = r.user_id
    where r.status = 'paused' and r.wake_at is not null and r.wake_at <= now() and not r.pause_requested
    order by r.wake_at limit 20`;
  let woken = 0;
  for (const r of due) {
    if (Date.now() > until) break; // the cron's time is up
    const woke = await taskTx(async (tx) => {
      await tx`select id from public.sessions where id = ${r.session_id} for no key update`;
      if (!r.enabled) {
        await tx`update public.runs set wake_at = null where id = ${r.id} and status = 'paused'`;
        return false;
      }
      const [run] = await tx`update public.runs set status = 'queued', wake_at = null
        where id = ${r.id} and status = 'paused' and wake_at is not null and wake_at <= now() and not pause_requested
          and exists (select 1 from public.agents a where a.id = runs.agent_id and a.archived_at is null)
        returning user_id`;
      if (!run) return false;
      await tx`update public.sessions set status = 'queued' where id = ${r.session_id}`;
      await tx`insert into public.events (user_id, session_id, run_id, type, status, data)
        values (${run.user_id}, ${r.session_id}, ${r.id}, 'status', 'done', ${tx.json({ text: 'The usage limit has reset, so the task carries on.', level: 'info', code: 'limit_reset' } satisfies StatusData as unknown as Json)})`;
      return true;
    });
    if (woke) {
      woken++;
      await kickRun(r.id);
    }
  }
  return woken;
}

// ---------------------------------------------------------------- agents asking agents (task.ask_agent)

/** Questions one run may ask other agents, and agents answering questions at once (per user). */
export const MAX_ASKS_PER_RUN = 5;
export const MAX_ACTIVE_ASKS = 3;
/** How long an asked agent may work on an answer before its task is stopped (the cron). */
export const ASK_MINUTES = 60;

const AUTONOMY_ORDER: Autonomy[] = ['careful', 'balanced', 'autonomous'];
/** The stricter of an agent's own autonomy and the cap its run got from the agent that asked. */
export function stricter(own: Autonomy, cap?: string | null): Autonomy {
  const i = cap ? AUTONOMY_ORDER.indexOf(cap as Autonomy) : -1;
  return i >= 0 && i < AUTONOMY_ORDER.indexOf(own) ? AUTONOMY_ORDER[i] : own;
}

const brainOf = (m: ModelRef | null | undefined) => {
  const label = sourceInfo(m?.source)?.label ?? m?.source ?? 'unknown';
  return m?.model && m.model !== 'default' ? `${label}, ${m.model}` : label;
};

/**
 * The agents a run's agent may ask, as its tool lists them: the ones the user picked in its settings that
 * still exist. None for a task another agent asked (one agent may ask another, but not further).
 */
export async function askableAgents(run: { user_id: string; agent_id: string; trigger: string }, tools: Partial<AgentTools>): Promise<AskableAgent[]> {
  const ids = (tools.agents ?? []).filter((x) => typeof x === 'string');
  if (run.trigger === 'agent' || !ids.length) return [];
  const rows = await db()`select name, model, instructions from public.agents
    where user_id = ${run.user_id} and id = any(${ids}::uuid[]) and id <> ${run.agent_id} and archived_at is null order by created_at`;
  return rows.map((r) => {
    const about = String(r.instructions ?? '').split('\n').map((l) => l.trim()).find(Boolean);
    return { name: String(r.name), brain: brainOf(r.model as ModelRef), ...(about ? { about: about.length > 120 ? `${about.slice(0, 119)}…` : about } : {}) };
  });
}

/**
 * Ask another of the user's agents (for the run `runId`): checks the asking agent may, then starts the asked
 * agent's task linked to this run. Everything is decided here from the database, never from what the
 * asking worker says about itself. The same key returns the task it started before.
 */
export async function askAgent(a: { userId: string; runId: string; lease?: string; key: string; agent: string; question: string }): Promise<AskAgentStart> {
  const sql = db();
  const [run] = await sql`select r.id, r.session_id, r.agent_id, r.trigger, r.autonomy_cap, ag.name as agent_name, ag.tools, ag.autonomy, s.title
    from public.runs r join public.agents ag on ag.id = r.agent_id join public.sessions s on s.id = r.session_id
    where r.id = ${a.runId} and r.user_id = ${a.userId}`;
  if (!run) return { error: 'This task wasn’t found.' };
  if (run.trigger === 'agent') return { error: 'You are answering another agent’s question, so you can’t ask a further agent. Answer with what you have.' };
  const allowed = ((run.tools as Partial<AgentTools>)?.agents ?? []).filter((x): x is string => typeof x === 'string');
  const candidates = allowed.length
    ? await sql`select id, name from public.agents where user_id = ${a.userId} and id = any(${allowed}::uuid[]) and id <> ${run.agent_id} and archived_at is null order by created_at`
    : [];
  const wanted = a.agent.trim().toLowerCase();
  const matches = candidates.filter((c) => String(c.name).trim().toLowerCase() === wanted);
  if (!matches.length) {
    const names = candidates.map((c) => c.name).join(', ');
    return { error: `${a.agent} isn’t one of the agents you may ask${names ? ` (you may ask: ${names})` : ''}. The user chooses them in your settings.` };
  }
  if (matches.length > 1) return { error: `More than one of the user’s agents is called ${matches[0].name}. Ask the user to rename one.` };
  const target = matches[0];
  try {
    const r = await startTask({
      userId: a.userId,
      agentId: target.id,
      text: a.question,
      parent: {
        runId: a.runId,
        sessionId: run.session_id,
        key: a.key,
        lease: a.lease,
        agentName: run.agent_name,
        taskTitle: run.title,
        // The asked agent acts with no more freedom than the one asking.
        autonomy: stricter(run.autonomy as Autonomy, run.autonomy_cap),
      },
    });
    return { sessionId: r.sessionId, agent: String(target.name) };
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.code === 'lease_lost') throw e;
      return { error: e.message };
    }
    throw e;
  }
}

/** Where the ask `key` of run `runId` stands: the asked task's first run (the one the ask started) says. */
export async function agentAnswer(userId: string, runId: string, key: string): Promise<AgentAnswer> {
  const [c] = await db()`
    select ag.name, r.status, r.result, r.error from public.sessions s join public.agents ag on ag.id = s.agent_id
      left join lateral (select status, result, error from public.runs where session_id = s.id and trigger = 'agent' order by created_at limit 1) r on true
    where s.parent_run_id = ${runId} and s.parent_ask_key = ${key} and s.user_id = ${userId}`;
  if (!c?.status) return { state: 'failed', agent: c?.name ?? '', error: 'That question was lost before an agent took it. Ask again if it still matters.' };
  const agent = String(c.name);
  switch (c.status) {
    case 'completed':
      return { state: 'answered', agent, answer: String(c.result ?? '') };
    case 'failed':
      return { state: 'failed', agent, error: `${agent} couldn’t answer: ${c.error ?? 'its task failed'}.` };
    case 'cancelled':
      return { state: 'failed', agent, error: `${agent} was stopped before it answered.` };
    default:
      return { state: 'pending', agent };
  }
}

/** Stop the agent answering ask `key` of run `runId` (the asker stopped waiting). */
export async function cancelAsk(userId: string, runId: string, key: string): Promise<void> {
  const rows = await db()`select r.id, r.session_id, ag.name as asker from public.runs r join public.sessions s on s.id = r.session_id
      join public.runs p on p.id = s.parent_run_id join public.agents ag on ag.id = p.agent_id
    where s.parent_run_id = ${runId} and s.parent_ask_key = ${key} and s.user_id = ${userId} and r.trigger = 'agent' and r.status in ('queued', 'running', 'waiting', 'paused')`;
  for (const r of rows) await stopAsked(userId, { id: String(r.id), session_id: String(r.session_id) }, `${r.asker} stopped waiting for this answer.`);
}

/**
 * Queue a run waiting only for other agents again (one of them answered). Under its task's locks, like
 * decideApproval: a run still running is left alone, since finishRun looks for answers when it stops.
 * A run also waiting for the user (an approval, a question) waits for that instead.
 */
export async function wakeForAnswer(runId: string): Promise<boolean> {
  const [ref] = await db()`select session_id from public.runs where id = ${runId}`;
  if (!ref) return false;
  const woke = await taskTx(async (tx) => {
    await tx`select id from public.sessions where id = ${ref.session_id} for no key update`;
    const [r] = await tx`update public.runs set status = 'queued', wake_at = null
      where id = ${runId} and status = 'waiting'
        and exists (select 1 from public.events where run_id = ${runId} and type = 'tool' and status = 'awaiting_agent')
        and not exists (select 1 from public.events where run_id = ${runId} and type = 'tool' and status in ('awaiting_approval', 'awaiting_input'))
      returning id`;
    if (r) await tx`update public.sessions set status = 'queued' where id = ${ref.session_id}`;
    return !!r;
  });
  if (woke) await kickRun(runId);
  return woke;
}

/** An asked agent's task ended: wake the run that asked. In its own transaction (never two tasks' locks at once). */
async function wakeAsker(sessionId: string) {
  const [s] = await db()`select parent_run_id from public.sessions where id = ${sessionId}`;
  if (s?.parent_run_id) await wakeForAnswer(s.parent_run_id);
}

/** The run that asked ended: the agents still answering it stop, and their tasks say why. */
async function stopAsks(userId: string, runId: string, askerName: string) {
  const rows = await db()`select r.id, r.session_id from public.runs r join public.sessions s on s.id = r.session_id
    where s.parent_run_id = ${runId} and r.trigger = 'agent' and r.status in ('queued', 'running', 'waiting', 'paused')`;
  for (const r of rows) await stopAsked(userId, { id: String(r.id), session_id: String(r.session_id) }, `${askerName}’s task ended, so it no longer needs this answer.`);
}

/** Stop an asked agent's run, saying why on its task first. */
async function stopAsked(userId: string, r: { id: string; session_id: string }, why: string) {
  await db()`insert into public.events (user_id, session_id, run_id, type, status, data)
    values (${userId}, ${r.session_id}, ${r.id}, 'status', 'done', ${db().json({ text: why, level: 'info' } satisfies StatusData as unknown as Json)})`;
  await cancelRun(userId, r.id);
}

/**
 * Cron backstop: wake runs whose asked agent answered but whose wake-up was missed (a crash between the
 * two), and stop asked agents that ran past ASK_MINUTES (the agent that asked then gets an error).
 */
export async function tidyAsks(until = Infinity): Promise<{ woken: number; stopped: number }> {
  const sql = db();
  const missed = await sql`
    select distinct e.run_id from public.events e
      join public.runs p on p.id = e.run_id and p.status = 'waiting'
      join public.sessions s on s.parent_run_id = e.run_id and s.parent_ask_key = e.id::text
      join public.runs c on c.session_id = s.id and c.trigger = 'agent'
    where e.type = 'tool' and e.status = 'awaiting_agent' and c.status in ('completed', 'failed', 'cancelled') and c.ended_at < now() - interval '30 seconds'
    limit 20`;
  let woken = 0;
  for (const m of missed) {
    if (Date.now() > until) break;
    if (await wakeForAnswer(m.run_id)) woken++;
  }
  const late = await sql`
    select r.id, r.user_id, r.session_id from public.runs r
    where r.trigger = 'agent' and r.status in ('queued', 'running', 'waiting', 'paused') and r.created_at < now() - make_interval(mins => ${ASK_MINUTES})
    order by r.created_at limit 20`;
  let stopped = 0;
  for (const r of late) {
    if (Date.now() > until) break;
    await sql`insert into public.events (user_id, session_id, run_id, type, status, data)
      values (${r.user_id}, ${r.session_id}, ${r.id}, 'status', 'done', ${sql.json({ text: `Stopped: the agent that asked waits at most ${ASK_MINUTES} minutes for an answer.`, level: 'warn' } satisfies StatusData as unknown as Json)})`;
    await cancelRun(r.user_id, r.id);
    stopped++;
  }
  return { woken, stopped };
}
