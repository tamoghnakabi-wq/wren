import { DESKTOP_ONLY_SOURCES, runContext, type LoopOutcome, type MessageData, type ModelRef, type Runtime, type StatusData } from '@wren/core';
import type { TransactionSql } from 'postgres';
import { db, type Json } from './db';
import { env, selfUrl } from './env';
import { HttpError } from './auth';
import { notifyUser, nudgeDevice } from './notify';
import { SandboxHost } from './runner/sandbox-host';

// Task lifecycle shared by the API routes, the cloud tick and the desktop API.

export const ACTIVE = ['queued', 'running', 'waiting', 'paused'] as const;

export interface StartTaskInput {
  userId: string;
  agentId: string;
  sessionId?: string;
  text: string;
  attachments?: { artifactId: string; name: string; mime: string; size: number }[];
  trigger?: 'user' | 'schedule';
  scheduleId?: string;
  scheduleName?: string;
  runtime?: Runtime; // override (e.g. "run this one in the cloud")
  deviceId?: string;
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
    const cont = await continueActiveRun(i.sessionId, i.userId, userMessage);
    if (cont) {
      if (cont.kick) await kickRun(cont.runId);
      return { sessionId: i.sessionId, runId: cont.runId, continued: true };
    }
  }

  const modelRef = agent.model as ModelRef;
  if (!modelRef?.source || !modelRef?.model) throw new HttpError(400, 'Choose a model for this agent first.', 'no_model');
  let runtime: Runtime = i.runtime ?? agent.runtime;
  if (DESKTOP_ONLY_SOURCES.includes(modelRef.source) && modelRef.source !== 'chatgpt') runtime = 'desktop';
  let deviceId: string | null = null;
  let device: { id: string; name: string; platform: string; policy: Record<string, unknown> } | undefined;
  if (runtime === 'desktop') {
    const wanted = i.deviceId ?? agent.device_id;
    const rows = wanted
      ? await sql`select id, name, platform, policy from public.devices where id = ${wanted} and user_id = ${i.userId} and revoked_at is null`
      : await sql`select id, name, platform, policy from public.devices where user_id = ${i.userId} and revoked_at is null order by last_seen_at desc nulls last limit 1`;
    if (!rows.length) throw new HttpError(400, 'This agent runs on your computer, but no desktop app is linked. Install Wren for Mac or Windows and link it.', 'no_device');
    device = rows[0] as typeof device;
    deviceId = device!.id;
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
  });
  const msg: MessageData & { context: string } = { ...(userMessage as MessageData), context };

  // Session (if new), run, first message and session state are created together.
  const created = await taskTx(async (tx) => {
    let sessionId = i.sessionId;
    if (sessionId) {
      const [session] = await tx`select id from public.sessions where id = ${sessionId} and user_id = ${i.userId} for no key update`;
      if (!session) throw new HttpError(404, 'Task not found.', 'not_found');
      // Someone else started a run while we were preparing: join it instead.
      const [active] = await tx`select id from public.runs where session_id = ${sessionId} and status in ('queued', 'running', 'waiting', 'paused') limit 1`;
      if (active) return { sessionId, runId: null as string | null };
    } else {
      const title = (text.split('\n')[0] || 'New task').slice(0, 80);
      const [s] = await tx`insert into public.sessions (user_id, agent_id, title, status, runtime, device_id)
        values (${i.userId}, ${agent.id}, ${title}, 'queued', ${runtime}, ${deviceId}) returning id`;
      sessionId = s.id as string;
    }
    const [run] = await tx`
      insert into public.runs (user_id, agent_id, session_id, status, runtime, device_id, trigger, schedule_id, model)
      values (${i.userId}, ${agent.id}, ${sessionId!}, 'queued', ${runtime}, ${deviceId}, ${i.trigger ?? 'user'}, ${i.scheduleId ?? null}, ${tx.json(modelRef as unknown as Json)})
      returning id`;
    await tx`insert into public.events (user_id, session_id, run_id, type, status, data) values (${i.userId}, ${sessionId!}, ${run.id}, 'message', 'done', ${tx.json(msg as unknown as Json)})`;
    await tx`update public.sessions set status = 'queued', runtime = ${runtime}, device_id = ${deviceId}, last_event_at = now() where id = ${sessionId!}`;
    await tx`update public.agents set last_active_at = now() where id = ${agent.id}`;
    return { sessionId: sessionId!, runId: run.id as string };
  });
  if (!created.runId) {
    const cont = await continueActiveRun(created.sessionId, i.userId, userMessage);
    if (!cont) throw new HttpError(409, 'The task changed while sending; try again.', 'conflict');
    if (cont.kick) await kickRun(cont.runId);
    return { sessionId: created.sessionId, runId: cont.runId, continued: true };
  }
  await kickRun(created.runId);
  return { sessionId: created.sessionId, runId: created.runId, continued: false };
}

/** Add a user message to the session's active run, resuming it if it was paused or waiting for this answer. */
async function continueActiveRun(sessionId: string, userId: string, message: Record<string, unknown>): Promise<{ runId: string; kick: boolean } | null> {
  return taskTx(async (tx) => {
    const [session] = await tx`select id from public.sessions where id = ${sessionId} and user_id = ${userId} for no key update`;
    if (!session) throw new HttpError(404, 'Task not found.', 'not_found');
    const [active] = await tx`select id, status from public.runs where session_id = ${sessionId} and status in ('queued', 'running', 'waiting', 'paused') order by created_at desc limit 1 for no key update`;
    if (!active) return null;
    await tx`insert into public.events (user_id, session_id, run_id, type, status, data)
      values (${userId}, ${sessionId}, ${active.id}, 'message', 'done', ${tx.json(message as unknown as Json)})`;
    await tx`update public.sessions set last_event_at = now() where id = ${sessionId}`;
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
async function taskTx<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
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

export async function finishRun(runId: string, outcome: LoopOutcome, leaseId?: string): Promise<FinishResult> {
  const sql = db();
  const [ref] = await sql`select session_id from public.runs where id = ${runId}`;
  if (!ref) return 'missing';
  const done = await taskTx(async (tx) => {
    await tx`select id from public.sessions where id = ${ref.session_id} for no key update`;
    const [run] = await tx`select r.*, a.name as agent_name, s.title from public.runs r join public.agents a on a.id = r.agent_id join public.sessions s on s.id = r.session_id where r.id = ${runId} for no key update of r`;
    if (!run) return 'missing' as const;
    if (leaseId && run.lease_id !== leaseId) return 'lease_lost' as const; // another worker owns the run now
    let o = outcome;
    // Stop was pressed while the worker was busy: whatever it reports next, the run ends cancelled.
    const cancelledLate = run.cancel_requested && !['completed', 'failed', 'cancelled'].includes(o.kind);
    if (cancelledLate) o = { kind: 'cancelled', steps: o.steps };
    let runStatus = o.kind === 'waiting_approval' || o.kind === 'waiting_input' ? 'waiting' : o.kind === 'yield' ? 'running' : o.kind;
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
        cleanup_pending = cleanup_pending or ${terminal && run.runtime === 'cloud'}
      where id = ${runId}`;
    if (cancelledLate) {
      await tx`update public.events set status = 'cancelled' where run_id = ${runId} and type = 'tool' and status in ('pending', 'awaiting_approval', 'awaiting_input', 'running')`;
      await tx`update public.approvals set status = 'cancelled' where run_id = ${runId} and status = 'pending'`;
    }
    await tx`update public.sessions set status = ${resume ? 'queued' : SESSION_STATUS[o.kind]}, last_event_at = now() where id = ${run.session_id}`;
    if (terminal) await tx`delete from public.run_live where run_id = ${runId}`;
    if (o.kind === 'failed') {
      await tx`insert into public.events (user_id, session_id, run_id, type, status, data)
        values (${run.user_id}, ${run.session_id}, ${runId}, 'status', 'done', ${tx.json({ text: o.error, level: 'error', ...(o.code ? { code: o.code } : {}) } satisfies StatusData as unknown as Json)})`;
    }
    return { run, o, resume, terminal };
  });
  if (typeof done === 'string') return done;
  const { run, o, resume, terminal } = done;
  if (resume) await kickRun(runId);
  // A finished run's shell jobs (background ones included) and browser tab end with it. The
  // flag set above stays until the VM confirms it, and the cron retries until then.
  if (terminalKind(o.kind) && !resume && run.runtime === 'cloud') await cleanUpCloudRun(run.agent_id, runId);

  const url = `/app/s/${run.session_id}`;
  if (o.kind === 'failed') {
    await notifyUser({ userId: run.user_id, kind: 'run_failed', title: `${run.agent_name} couldn't finish`, body: `${run.title}: ${o.error}`.slice(0, 300), url, sessionId: run.session_id });
  } else if (o.kind === 'completed') {
    await notifyUser({ userId: run.user_id, kind: 'run_completed', title: `${run.agent_name} finished`, body: (o.result || run.title).replace(/[#*_`>]/g, '').slice(0, 280), url, sessionId: run.session_id });
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

export async function cancelRun(userId: string, runId: string) {
  const sql = db();
  const [run] = await sql`update public.runs set cancel_requested = true where id = ${runId} and user_id = ${userId} and status in ('queued', 'running', 'waiting', 'paused') returning status, runtime, session_id, lease_until`;
  if (!run) return;
  await sql`update public.approvals set status = 'cancelled' where run_id = ${runId} and status = 'pending'`;
  // Nothing is executing a waiting/paused/queued run: finish it here.
  if (run.status !== 'running' || !run.lease_until || new Date(run.lease_until) < new Date()) {
    await sql`update public.events set status = 'cancelled' where run_id = ${runId} and type = 'tool' and status in ('pending', 'awaiting_approval', 'awaiting_input', 'running')`;
    await finishRun(runId, { kind: 'cancelled', steps: 0 });
  } else if (run.runtime === 'cloud') {
    // A tick is mid-step: end the run's commands now so it notices Stop without waiting them out.
    const [r] = await sql`select agent_id from public.runs where id = ${runId}`;
    if (r) await SandboxHost.endRun(r.agent_id, runId);
  }
  if (run.runtime === 'desktop') await kickRun(runId);
}

export async function pauseRun(userId: string, runId: string) {
  const sql = db();
  const [run] = await sql`update public.runs set pause_requested = true where id = ${runId} and user_id = ${userId} and status in ('queued', 'running') returning status, session_id, runtime, lease_until`;
  if (!run) return;
  if (run.status === 'queued' || !run.lease_until || new Date(run.lease_until) < new Date()) {
    await sql`update public.runs set status = 'paused' where id = ${runId}`;
    await sql`update public.sessions set status = 'paused' where id = ${run.session_id}`;
  }
  if (run.runtime === 'desktop') await kickRun(runId);
}

export async function resumeRun(userId: string, runId: string) {
  const sql = db();
  const [run] = await sql`update public.runs set pause_requested = false, status = 'queued', wake_at = null where id = ${runId} and user_id = ${userId} and status = 'paused' returning session_id`;
  if (!run) return;
  await sql`update public.sessions set status = 'queued' where id = ${run.session_id}`;
  await kickRun(runId);
}
