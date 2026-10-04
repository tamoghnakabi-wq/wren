import { DESKTOP_ONLY_SOURCES, runContext, type LoopOutcome, type MessageData, type ModelRef, type Runtime, type StatusData } from '@wren/core';
import { db, type Json } from './db';
import { env, selfUrl } from './env';
import { HttpError } from './auth';
import { notifyUser, nudgeDevice } from './notify';

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

  // Continue an active run in this session instead of starting a new one.
  if (i.sessionId) {
    const [session] = await sql`select * from public.sessions where id = ${i.sessionId} and user_id = ${i.userId}`;
    if (!session) throw new HttpError(404, 'Task not found.', 'not_found');
    const [active] = await sql`select * from public.runs where session_id = ${i.sessionId} and status in ('queued', 'running', 'waiting', 'paused') order by created_at desc limit 1`;
    if (active) {
      await sql`insert into public.events (user_id, session_id, run_id, type, status, data)
        values (${i.userId}, ${i.sessionId}, ${active.id}, 'message', 'done', ${sql.json({ role: 'user', text: text + attachNote, images: imageRefs, attachments: i.attachments ?? [] } as unknown as Json)})`;
      await sql`update public.sessions set last_event_at = now() where id = ${i.sessionId}`;
      const waitingForInput = await sql`select 1 from public.events where run_id = ${active.id} and type = 'tool' and status = 'awaiting_input' limit 1`;
      if (active.status === 'paused' || (active.status === 'waiting' && waitingForInput.length)) {
        await sql`update public.runs set status = 'queued', pause_requested = false, wake_at = null where id = ${active.id}`;
        await sql`update public.sessions set status = 'queued' where id = ${i.sessionId}`;
        await kickRun(active.id);
      }
      return { sessionId: i.sessionId, runId: active.id, continued: true };
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

  let sessionId = i.sessionId;
  if (!sessionId) {
    const title = (text.split('\n')[0] || 'New task').slice(0, 80);
    const [s] = await sql`insert into public.sessions (user_id, agent_id, title, status, runtime, device_id)
      values (${i.userId}, ${agent.id}, ${title}, 'queued', ${runtime}, ${deviceId}) returning id`;
    sessionId = s.id as string;
  }
  const [run] = await sql`
    insert into public.runs (user_id, agent_id, session_id, status, runtime, device_id, trigger, schedule_id, model)
    values (${i.userId}, ${agent.id}, ${sessionId!}, 'queued', ${runtime}, ${deviceId}, ${i.trigger ?? 'user'}, ${i.scheduleId ?? null}, ${sql.json(modelRef as unknown as Json)})
    returning id`;
  const msg: MessageData & { context: string } = { role: 'user', text: text + attachNote, images: imageRefs, attachments: i.attachments ?? [], context };
  await sql`insert into public.events (user_id, session_id, run_id, type, status, data) values (${i.userId}, ${sessionId!}, ${run.id}, 'message', 'done', ${sql.json(msg as unknown as Json)})`;
  await sql`update public.sessions set status = 'queued', runtime = ${runtime}, device_id = ${deviceId}, last_event_at = now() where id = ${sessionId!}`;
  await sql`update public.agents set last_active_at = now() where id = ${agent.id}`;
  await kickRun(run.id);
  return { sessionId: sessionId!, runId: run.id, continued: false };
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
 */
export async function finishRun(runId: string, outcome: LoopOutcome, leaseId?: string): Promise<void> {
  const sql = db();
  const [run] = await sql`select r.*, a.name as agent_name, s.title from public.runs r join public.agents a on a.id = r.agent_id join public.sessions s on s.id = r.session_id where r.id = ${runId}`;
  if (!run) return;
  // Stop was pressed while the worker was busy: whatever it reports next, the run ends cancelled.
  if (run.cancel_requested && !['completed', 'failed', 'cancelled'].includes(outcome.kind)) {
    outcome = { kind: 'cancelled', steps: outcome.steps };
    await sql`update public.events set status = 'cancelled' where run_id = ${runId} and type = 'tool' and status in ('pending', 'awaiting_approval', 'awaiting_input', 'running')`;
    await sql`update public.approvals set status = 'cancelled' where run_id = ${runId} and status = 'pending'`;
  }
  let runStatus =
    outcome.kind === 'waiting_approval' || outcome.kind === 'waiting_input' ? 'waiting' : outcome.kind === 'yield' ? 'running' : outcome.kind;
  // The user may have answered the approval while the worker was still stopping: don't strand the run.
  let decidedEarly = false;
  if (outcome.kind === 'waiting_approval') {
    const [a] = await sql`select status from public.approvals where id = ${outcome.approvalId} and run_id = ${runId}`;
    decidedEarly = !!a && ['approved', 'denied', 'expired'].includes(a.status);
    if (decidedEarly) runStatus = 'queued';
  }
  const terminal = ['completed', 'failed', 'cancelled'].includes(runStatus);
  const updated = await sql`
    update public.runs set status = ${runStatus}, step = greatest(step, ${outcome.steps}), lease_id = null, lease_until = null,
      error = ${outcome.kind === 'failed' ? outcome.error : null},
      result = ${outcome.kind === 'completed' ? outcome.result.slice(0, 20000) : run.result},
      ended_at = ${terminal ? new Date() : null}
    where id = ${runId} and (${leaseId ?? null}::uuid is null or lease_id = ${leaseId ?? null}::uuid)
    returning id`;
  if (!updated.length) return; // another worker owns the run now
  await sql`update public.sessions set status = ${decidedEarly ? 'queued' : SESSION_STATUS[outcome.kind]}, last_event_at = now() where id = ${run.session_id}`;
  if (decidedEarly) await kickRun(runId);
  if (terminal) await sql`delete from public.run_live where run_id = ${runId}`;

  const url = `/app/s/${run.session_id}`;
  if (outcome.kind === 'failed') {
    await sql`insert into public.events (user_id, session_id, run_id, type, status, data)
      values (${run.user_id}, ${run.session_id}, ${runId}, 'status', 'done', ${sql.json({ text: outcome.error, level: 'error', ...(outcome.code ? { code: outcome.code } : {}) } satisfies StatusData as unknown as Json)})`;
    await notifyUser({ userId: run.user_id, kind: 'run_failed', title: `${run.agent_name} couldn't finish`, body: `${run.title}: ${outcome.error}`.slice(0, 300), url, sessionId: run.session_id });
  } else if (outcome.kind === 'completed') {
    await notifyUser({ userId: run.user_id, kind: 'run_completed', title: `${run.agent_name} finished`, body: (outcome.result || run.title).replace(/[#*_`>]/g, '').slice(0, 280), url, sessionId: run.session_id });
  } else if (outcome.kind === 'waiting_input') {
    // the question notification is sent by the loop's ask_user handler
  }
}

/** Approve or deny a pending approval; resumes the run. */
export async function decideApproval(userId: string, approvalId: string, approve: boolean, via: string, note?: string): Promise<{ runId: string; status: string }> {
  const sql = db();
  const [pre] = await sql`select detail from public.approvals where id = ${approvalId} and user_id = ${userId}`;
  if (pre?.detail?.localOnly && via !== 'desktop') {
    throw new HttpError(403, 'This computer only accepts approvals made on it (remote approvals are turned off in its Wren settings).', 'local_only');
  }
  const rows = await sql`
    update public.approvals set status = ${approve ? 'approved' : 'denied'}, decided_at = now(), decided_via = ${via}, note = ${note ?? null}
    where id = ${approvalId} and user_id = ${userId} and status = 'pending' and expires_at > now()
    returning run_id, session_id`;
  if (!rows.length) {
    const [a] = await sql`select status, run_id from public.approvals where id = ${approvalId} and user_id = ${userId}`;
    if (!a) throw new HttpError(404, 'Approval not found.', 'not_found');
    return { runId: a.run_id, status: a.status };
  }
  const { run_id: runId, session_id: sessionId } = rows[0];
  const [run] = await sql`update public.runs set status = 'queued' where id = ${runId} and status = 'waiting' returning id`;
  await sql`update public.sessions set status = 'queued' where id = ${sessionId}`;
  if (run) await kickRun(runId);
  return { runId, status: approve ? 'approved' : 'denied' };
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
