import { randomUUID } from 'node:crypto';
import { runLoop, systemPrompt, toolCatalog, DEFAULT_TOOLS, type AgentTools, type ImageRef, type LoopOutcome, type ModelRef, type StatusData, type ToolSpec } from '@wren/core';
import { readArtifactBytes } from '../blob';
import { db } from '../db';
import { resolveCloudModel, connectionSecret } from '../models';
import { notifyUser } from '../notify';
import { finishRun, kickTick } from '../runs';
import { DbRunStore, LeaseLostError } from './store';
import { mcpNamespace, mcpToolSpecs, type McpToolInfo } from '../mcp';
import { SandboxHost, WORKSPACE } from './sandbox-host';

// One "tick" of a cloud run: claim the lease, run the agent loop for up to
// ~4 minutes (Vercel Functions cap at 5), persist the outcome and, if work
// remains, invoke the next tick. A pg_cron watchdog re-kicks runs whose lease
// expired (crashed or timed-out ticks).

const LEASE_SECONDS = 320;
const BUDGET_MS = 235_000;
const MODEL_BUDGET_MS = 185_000;
const MAX_CRASHES = 3;

export async function runTick(runId: string): Promise<string> {
  const sql = db();
  const lease = randomUUID();
  // A lease that is still set but expired means the previous tick was killed
  // (e.g. hit the function time limit) without cleaning up: count it as a crash.
  const claimed = await sql`
    update public.runs set lease_id = ${lease}, lease_until = now() + make_interval(secs => ${LEASE_SECONDS}),
      status = case when status = 'queued' then 'running' else status end,
      crash_count = crash_count + case when lease_id is not null then 1 else 0 end,
      started_at = coalesce(started_at, now()), wake_at = null
    where id = ${runId} and runtime = 'cloud' and status in ('queued', 'running')
      and (lease_until is null or lease_until < now()) and (wake_at is null or wake_at <= now())
    returning *`;
  if (!claimed.length) return 'not-claimed';
  const run = claimed[0];
  const started = Date.now();
  if (Number(run.crash_count) >= MAX_CRASHES) {
    await finishRun(runId, { kind: 'failed', error: 'The run kept stopping before it could finish a step (each attempt ran out of time). Try a smaller task or a faster model.', steps: run.step }, lease);
    return 'failed';
  }

  const [agent] = await sql`select * from public.agents where id = ${run.agent_id}`;
  const [profile] = await sql`select email from public.profiles where id = ${run.user_id}`;
  if (!agent) {
    await finishRun(runId, { kind: 'failed', error: 'The agent was deleted.', steps: run.step }, lease);
    return 'failed';
  }
  await sql`update public.sessions set status = 'running' where id = ${run.session_id} and status <> 'running'`;

  const modelRef = run.model as ModelRef;
  const store = new DbRunStore({ runId, sessionId: run.session_id, agentId: agent.id, userId: run.user_id, agentName: agent.name, source: modelRef.source, leaseId: lease });
  const tools = { ...DEFAULT_TOOLS, ...(agent.tools as Partial<AgentTools>) };
  const github = tools.github ? await connectionSecret(run.user_id, 'github') : null;
  const mcp = new Map<string, { url: string; token?: string; tools: McpToolInfo[] }>();
  const mcpSpecs: ToolSpec[] = [];
  if (tools.mcp?.length) {
    const conns = await sql`select id, label, config from public.connections where user_id = ${run.user_id} and provider = 'mcp' and status <> 'disabled' and id = any(${tools.mcp}::uuid[])`;
    for (const c of conns) {
      const secret = await connectionSecret(run.user_id, 'mcp', c.id);
      const list = (c.config.tools ?? []) as McpToolInfo[];
      mcp.set(mcpNamespace(c.id), { url: c.config.url, token: secret?.secret, tools: list });
      mcpSpecs.push(...mcpToolSpecs(c.id, c.label, list));
    }
  }

  const host = new SandboxHost({
    agentId: agent.id,
    userId: run.user_id,
    sessionId: run.session_id,
    runId,
    githubToken: github?.secret,
    mcp,
    onLiveView: (p) => store.live({ image: p.data, url: p.url, title: p.title }),
  });

  const loadImage = async (ref: ImageRef) => {
    if (ref.data) return { mime: ref.mime, data: ref.data };
    if (!ref.artifactId) return null;
    const cached = host.imageCache.get(ref.artifactId);
    if (cached) return cached;
    const [a] = await sql`select blob_path, mime from public.artifacts where id = ${ref.artifactId} and user_id = ${run.user_id}`;
    if (!a) return null;
    const bytes = await readArtifactBytes(a.blob_path);
    if (!bytes) return null;
    const v = { mime: a.mime, data: bytes.toString('base64') };
    host.imageCache.set(ref.artifactId, v);
    return v;
  };

  let outcome: LoopOutcome;
  try {
    const access = await resolveCloudModel({ id: run.user_id, email: profile?.email ?? '' }, modelRef, loadImage);
    if (access.note && run.step === 0) await store.append<StatusData>('status', { text: access.note, level: 'info' }, 'done');
    const instructions = systemPrompt({ name: agent.name, instructions: agent.instructions }, 'cloud').replace('/workspace', WORKSPACE);
    outcome = await runLoop({
      model: access.client,
      modelName: access.model,
      source: access.source,
      effort: modelRef.effort,
      instructions,
      tools: toolCatalog({ runtime: 'cloud', tools, githubConnected: !!github, extra: mcpSpecs }),
      hosted: tools.web && access.webSearch ? [{ type: 'web_search' }] : [],
      runId,
      autonomy: agent.autonomy,
      store,
      host,
      deadline: started + BUDGET_MS,
      modelDeadline: started + MODEL_BUDGET_MS,
      step: run.step,
      maxSteps: run.max_steps,
      modelRetries: Number(run.retry_count) || 0,
      log: (m, e) => console.log(`[run ${runId.slice(0, 8)}] ${m}`, e ?? ''),
    });
  } catch (e) {
    const err = e as Error & { status?: number; code?: string };
    if (e instanceof LeaseLostError) return 'lease-lost';
    if (err.status && err.status < 500) {
      outcome = { kind: 'failed', error: err.message, code: err.code, steps: run.step };
    } else {
      console.error(`[run ${runId}] tick crashed`, e);
      const crashes = Number(run.crash_count) + 1;
      if (crashes >= MAX_CRASHES) {
        outcome = { kind: 'failed', error: `The run kept failing: ${err.message}`, steps: run.step };
      } else {
        await sql`update public.runs set crash_count = ${crashes}, lease_id = null, lease_until = null, wake_at = now() + interval '20 seconds' where id = ${runId} and lease_id = ${lease}`;
        return 'crashed';
      }
    }
  }

  if (outcome.kind === 'yield') {
    // A clean hand-off proves ticks finish in time, so earlier timeouts no longer count, unless
    // the tick only failed to reach the model: then the loop's retry count (which fails the run
    // once it runs out) carries over and the crash count stays. A completed step resets both.
    const wakeMs = outcome.wakeInMs ?? 0;
    const progressed = outcome.steps > Number(run.step);
    const retries = outcome.retries ?? (progressed ? 0 : Number(run.retry_count) || 0);
    const crashes = outcome.retries !== undefined && !progressed ? Number(run.crash_count) : 0;
    const handed = await sql`update public.runs set step = ${outcome.steps}, lease_id = null, lease_until = null, crash_count = ${crashes}, retry_count = ${retries},
      wake_at = ${wakeMs ? new Date(Date.now() + wakeMs) : null} where id = ${runId} and lease_id = ${lease} returning id`;
    if (handed.length && !wakeMs) await kickTick(runId);
    return 'yield';
  }
  await finishRun(runId, outcome, lease);
  if (outcome.kind === 'completed' || outcome.kind === 'failed' || outcome.kind === 'cancelled') {
    const others = await sql`select 1 from public.runs where agent_id = ${agent.id} and runtime = 'cloud' and status in ('queued', 'running') and id <> ${runId} limit 1`;
    if (!others.length) await host.stop();
  }
  return outcome.kind;
}

export { notifyUser };
