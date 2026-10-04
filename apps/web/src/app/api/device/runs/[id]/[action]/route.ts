import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createModelClient, DEFAULT_TOOLS, friendlyModelError, systemPrompt, type AgentTools, type ImageRef, type LoopOutcome, type ModelRef, type ModelStreamEvent } from '@wren/core';
import { HttpError, requireDevice, type AuthDevice } from '@/lib/auth';
import { readArtifactBytes } from '@/lib/blob';
import { db, type Json } from '@/lib/db';
import { body, json, route, uuid } from '@/lib/http';
import { callMcp, mcpNamespace, mcpToolSpecs, type McpToolInfo } from '@/lib/mcp';
import { canUsePlatform, connectionSecret } from '@/lib/models';
import { decideApproval, finishRun } from '@/lib/runs';
import { DbRunStore } from '@/lib/runner/store';
import { getVercelOidcToken } from '@vercel/oidc';

// Everything a desktop device needs to execute a run it owns. The device runs
// the agent loop locally; this API is its persistence, approvals, notification
// and (for API-key providers) model proxy, so keys never leave the server.

export const maxDuration = 300;
const LEASE_SECONDS = 150;
type Ctx = { params: Promise<{ id: string; action: string }> };

async function loadRun(device: AuthDevice, runId: string) {
  const [run] = await db()`select r.*, a.name as agent_name from public.runs r join public.agents a on a.id = r.agent_id where r.id = ${runId} and r.device_id = ${device.id} and r.user_id = ${device.userId}`;
  if (!run) throw new HttpError(404, 'Run not found for this device.', 'not_found');
  return run;
}

/**
 * Everything except claiming and deciding needs the lease this device got when it
 * claimed the run; once someone else holds it (or the run was finished), writes stop.
 */
function requireLease(run: Record<string, unknown>, lease: string | null) {
  if (!lease || !uuid.safeParse(lease).success || run.lease_id !== lease) {
    throw new HttpError(409, 'This computer no longer holds this run.', 'lease_lost');
  }
}

function storeFor(run: Record<string, unknown>, source?: string) {
  return new DbRunStore({ runId: run.id as string, sessionId: run.session_id as string, agentId: run.agent_id as string, userId: run.user_id as string, agentName: run.agent_name as string, source: source ?? (run.model as ModelRef).source });
}

async function renew(runId: string, leaseId: string | null) {
  if (!leaseId) return;
  await db()`update public.runs set lease_until = now() + make_interval(secs => ${LEASE_SECONDS}) where id = ${runId} and lease_id = ${leaseId}`;
}

export const POST = route<Ctx>(async (req, ctx) => {
  const device = await requireDevice(req);
  const p = await ctx.params;
  const runId = uuid.parse(p.id);
  const run = await loadRun(device, runId);
  const sql = db();
  const lease = req.headers.get('x-wren-lease');
  const raw = p.action === 'model' || p.action === 'claim' ? undefined : await req.json().catch(() => ({}));
  if (p.action !== 'claim' && p.action !== 'decide' && p.action !== 'approval-info') requireLease(run, lease);

  switch (p.action) {
    case 'claim': {
      const leaseId = randomUUID();
      const claimed = await sql`
        update public.runs set lease_id = ${leaseId}, lease_until = now() + make_interval(secs => ${LEASE_SECONDS}),
          status = case when status = 'queued' then 'running' else status end, started_at = coalesce(started_at, now())
        where id = ${runId} and status in ('queued', 'running') and (lease_until is null or lease_until < now() or lease_id = ${lease ?? leaseId})
        returning *`;
      if (!claimed.length) return json({ claimed: false });
      await sql`update public.sessions set status = 'running' where id = ${run.session_id}`;
      const [agent] = await sql`select id, name, instructions, model, tools, autonomy, memory_enabled from public.agents where id = ${run.agent_id}`;
      const tools = { ...DEFAULT_TOOLS, ...(agent.tools as Partial<AgentTools>) };
      const mcpTools = [];
      if (tools.mcp?.length) {
        const conns = await sql`select id, label, config from public.connections where user_id = ${run.user_id} and provider = 'mcp' and id = any(${tools.mcp}::uuid[])`;
        for (const c of conns) mcpTools.push(...mcpToolSpecs(c.id, c.label, (c.config.tools ?? []) as McpToolInfo[]));
      }
      const github = tools.github ? !!(await connectionSecret(run.user_id, 'github')) : false;
      return json({
        claimed: true,
        leaseId,
        run: { id: run.id, sessionId: run.session_id, step: claimed[0].step, maxSteps: claimed[0].max_steps, model: run.model, trigger: run.trigger },
        agent: { id: agent.id, name: agent.name, autonomy: agent.autonomy, tools, instructions: systemPrompt({ name: agent.name, instructions: agent.instructions }, 'desktop', device.platform) },
        mcpTools,
        githubConnected: github,
      });
    }
    case 'events': {
      await renew(runId, lease);
      return json({ events: await storeFor(run).events() });
    }
    case 'append': {
      const b = z.object({ type: z.enum(['message', 'tool', 'status', 'plan', 'reasoning']), data: z.unknown(), status: z.string().max(30).optional() }).parse(raw);
      await renew(runId, lease);
      return json(await storeFor(run).append(b.type, b.data, b.status));
    }
    case 'update': {
      const b = z.object({ id: z.string().uuid(), data: z.unknown().optional(), status: z.string().max(30).optional() }).parse(raw);
      await storeFor(run).update(b.id, { data: b.data, status: b.status });
      await renew(runId, lease);
      return json({ ok: true });
    }
    case 'control': {
      await renew(runId, lease);
      return json(await storeFor(run).control());
    }
    case 'approval': {
      const b = z.object({ eventId: z.string().uuid(), tool: z.string(), title: z.string(), risk: z.enum(['low', 'medium', 'high', 'critical']), reason: z.string().optional(), args: z.record(z.string(), z.unknown()), localOnly: z.boolean().optional() }).parse(raw);
      const id = await storeFor(run).createApproval(b, { localOnly: b.localOnly });
      return json({ id });
    }
    case 'decide': {
      const b = z.object({ id: z.string().uuid(), approve: z.boolean() }).parse(raw);
      const [a] = await sql`select id from public.approvals where id = ${b.id} and run_id = ${runId}`;
      if (!a) throw new HttpError(404, 'Approval not found for this run.', 'not_found');
      return json(await decideApproval(run.user_id as string, b.id, b.approve, 'desktop'));
    }
    case 'approval-info': {
      // For the desktop's native prompt: what one of this run's approvals asks for.
      const b = z.object({ id: z.string().uuid() }).parse(raw);
      const [a] = await sql`select id, title, risk, status, detail from public.approvals where id = ${b.id} and run_id = ${runId}`;
      if (!a) throw new HttpError(404, 'Approval not found for this run.', 'not_found');
      return json({ id: a.id, title: a.title, risk: a.risk, status: a.status, reason: a.detail?.reason ?? null, args: a.detail?.args ?? {}, agentName: run.agent_name });
    }
    case 'approval-state': {
      const b = z.object({ id: z.string().uuid() }).parse(raw);
      return json({ state: await storeFor(run).approvalState(b.id) });
    }
    case 'usage': {
      const b = z.object({ model: z.string(), inputTokens: z.number(), outputTokens: z.number(), cachedTokens: z.number(), source: z.string().max(30).optional() }).parse(raw);
      const s = storeFor(run, b.source);
      await s.recordUsage(b, b.model);
      return json({ ok: true });
    }
    case 'notify': {
      const b = z.object({ title: z.string().max(200), body: z.string().max(2000), kind: z.string().max(30) }).parse(raw);
      await storeFor(run).notify(b.title, b.body, b.kind);
      return json({ ok: true });
    }
    case 'memory': {
      const b = z.object({ op: z.enum(['add', 'remove']), value: z.string().max(600) }).parse(raw);
      const s = storeFor(run);
      return json(b.op === 'add' ? { id: await s.memory.add(b.value) } : { ok: await s.memory.remove(b.value) });
    }
    case 'artifact': {
      // Image bytes for model input (e.g. an uploaded screenshot), scoped to this run's user.
      const b = z.object({ id: z.string().uuid() }).parse(raw);
      const [a] = await sql`select blob_path, mime, size from public.artifacts where id = ${b.id} and user_id = ${run.user_id}`;
      if (!a || !String(a.mime).startsWith('image/') || Number(a.size) > 20 * 1024 * 1024) return json({ found: false });
      const bytes = await readArtifactBytes(a.blob_path);
      return json(bytes ? { found: true, mime: a.mime, data: bytes.toString('base64') } : { found: false });
    }
    case 'live': {
      const b = z.object({ image: z.string().max(400_000), url: z.string().max(2000).optional(), title: z.string().max(300).optional() }).parse(raw);
      await sql`insert into public.run_live (run_id, user_id, session_id, image, url, title, updated_at)
        values (${runId}, ${run.user_id}, ${run.session_id}, ${b.image}, ${b.url ?? null}, ${b.title ?? null}, now())
        on conflict (run_id) do update set image = excluded.image, url = excluded.url, title = excluded.title, updated_at = now()`;
      return json({ ok: true });
    }
    case 'mcp': {
      const b = z.object({ name: z.string(), args: z.record(z.string(), z.unknown()) }).parse(raw);
      const ns = b.name.slice(0, b.name.indexOf('.'));
      const conns = await sql`select id, config from public.connections where user_id = ${run.user_id} and provider = 'mcp'`;
      const c = conns.find((x) => mcpNamespace(x.id) === ns);
      const tool = (c?.config.tools as McpToolInfo[] | undefined)?.find((t) => t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) === b.name.slice(ns.length + 1));
      if (!c || !tool) return json({ output: 'That connected tool is no longer available.', isError: true });
      const secret = await connectionSecret(run.user_id, 'mcp', c.id);
      return json(await callMcp(c.config.url, secret?.secret, tool.name, b.args));
    }
    case 'github': {
      const b = z.object({ method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']), path: z.string().max(500), body: z.unknown().optional() }).parse(raw);
      const gh = await connectionSecret(run.user_id, 'github');
      if (!gh) return json({ output: 'GitHub is not connected. Ask the user to connect it in Connections.', isError: true });
      if (!b.path.startsWith('/')) return json({ output: 'Path must start with /', isError: true });
      const res = await fetch(`https://api.github.com${b.path}`, {
        method: b.method,
        headers: { authorization: `Bearer ${gh.secret}`, accept: 'application/vnd.github+json', 'user-agent': 'wren-agent' },
        body: b.method === 'GET' || b.body === undefined ? undefined : JSON.stringify(b.body),
      });
      const text = await res.text();
      return json({ output: `HTTP ${res.status}\n${text.slice(0, 40000)}`, isError: res.status >= 400 });
    }
    case 'finish': {
      const outcome = raw as LoopOutcome;
      if (!outcome || typeof outcome.kind !== 'string') throw new HttpError(400, 'Invalid outcome', 'invalid');
      if (outcome.kind === 'yield') {
        await sql`update public.runs set lease_id = null, lease_until = null, step = greatest(step, ${outcome.steps}) where id = ${runId} and lease_id = ${lease}`;
      } else {
        await finishRun(runId, outcome, lease!);
      }
      return json({ ok: true });
    }
    case 'model':
      return modelProxy(req, run);
  }
  throw new HttpError(404, 'Unknown action.', 'not_found');
});

// Streams NDJSON: {"type":"text","delta":...}... then {"type":"final","turn":...}
// or {"type":"error",...}. The transcript is read from the database.
async function modelProxy(req: Request, run: Record<string, unknown>): Promise<Response> {
  const b = z
    .object({
      source: z.enum(['openai', 'anthropic', 'xai', 'gateway', 'platform']),
      model: z.string().max(200),
      connectionId: z.string().uuid().optional(),
      effort: z.enum(['low', 'medium', 'high']).optional(),
      instructions: z.string().max(100_000),
      tools: z.array(z.object({ namespace: z.string(), name: z.string(), description: z.string(), parameters: z.record(z.string(), z.unknown()) })).max(200),
      hosted: z.array(z.object({ type: z.literal('web_search') })).max(2),
    })
    .parse(await req.json());
  const userId = run.user_id as string;
  let credential: string | (() => Promise<string>);
  if (b.source === 'platform') {
    const [p] = await db()`select email from public.profiles where id = ${userId}`;
    if (!canUsePlatform({ email: p?.email ?? '' })) throw new HttpError(403, 'Wren credits are not enabled for this account.', 'platform_denied');
    credential = () => getVercelOidcToken();
  } else {
    const key = await connectionSecret(userId, b.source, b.connectionId);
    if (!key) throw new HttpError(400, `Connect your ${b.source} API key in Connections first.`, 'no_credentials');
    credential = key.secret;
  }
  const loadImage = async (ref: ImageRef) => {
    if (!ref.artifactId) return null;
    const [a] = await db()`select blob_path, mime from public.artifacts where id = ${ref.artifactId} and user_id = ${userId}`;
    const bytes = a ? await readArtifactBytes(a.blob_path) : null;
    return bytes ? { mime: a.mime, data: bytes.toString('base64') } : null;
  };
  const client = createModelClient({ source: b.source, credential, loadImage });
  const events = await storeFor(run).events();
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + '\n'));
      try {
        const turn = await client.stream(
          { model: b.model, instructions: b.instructions, events, tools: b.tools, hosted: b.hosted, effort: b.effort, signal: req.signal },
          (e: ModelStreamEvent) => send(e),
        );
        send({ type: 'final', turn });
      } catch (e) {
        const err = e as { message: string; status?: number; code?: string; retryable?: boolean };
        send({ type: 'error', message: friendlyModelError(err), raw: err.message, status: err.status, code: err.code, retryable: !!err.retryable });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
}

