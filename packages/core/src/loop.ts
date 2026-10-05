import { assessCall, assessShell, needsApproval, type BrowserTarget } from './policy';
import { describeCall } from './tools';
import { clipMiddle } from './transcript';
import type {
  Autonomy,
  HostedTool,
  MessageData,
  ModelClient,
  ModelError,
  ModelUsage,
  PlanItem,
  Risk,
  Runtime,
  SessionEvent,
  StatusData,
  ToolCallData,
  ToolResult,
  ToolSpec,
} from './types';

// The agent loop. It is written as a resumable state machine over the session's
// event log so it can run in short "ticks" (Vercel Functions) or continuously
// (desktop): every decision is persisted before it is acted on, and a tick can
// stop at any boundary and be picked up later by another process.

export const MAX_TOOL_OUTPUT = 30_000;

export interface ApprovalRequest {
  eventId: string;
  tool: string;
  title: string;
  risk: Risk;
  reason?: string;
  args: Record<string, unknown>;
}

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface RunStore {
  events(): Promise<SessionEvent[]>;
  append<T>(type: SessionEvent['type'], data: T, status?: string): Promise<SessionEvent<T>>;
  update(id: string, patch: { data?: unknown; status?: string }): Promise<void>;
  control(): Promise<{ cancel: boolean; pause: boolean }>;
  createApproval(req: ApprovalRequest): Promise<string>;
  approvalState(id: string): Promise<ApprovalState>;
  recordUsage(usage: ModelUsage, model: string): Promise<void>;
  notify(title: string, body: string, kind: string): Promise<void>;
  memory: {
    add(fact: string): Promise<string>;
    remove(id: string): Promise<boolean>;
  };
}

export interface ToolContext {
  runtime: Runtime;
  deadline: number;
  signal?: AbortSignal;
  callId: string;
  /** Persist progress for long-running tools (e.g. a background job handle). */
  checkpoint(background: ToolCallData['background']): Promise<void>;
  /** Whether the user pressed Stop (tools that wait should check it now and then). */
  isCancelled?: () => Promise<boolean>;
  /** For browser actions: the element that was assessed; the browser refuses if it changed. */
  expect?: ToolCallData['target'];
}

export interface ToolHost {
  readonly runtime: Runtime;
  /** Extra information the policy needs (element behind a browser ref, whether a file exists). */
  riskContext?(name: string, args: Record<string, unknown>): Promise<{ browserTarget?: BrowserTarget; fileExists?: boolean; mcpReadOnly?: boolean; unsandboxed?: boolean }>;
  execute(name: string, args: Record<string, unknown>, ctx: ToolContext, resume?: ToolCallData['background']): Promise<ToolResult | { yield: true }>;
}

export interface LoopOptions {
  model: ModelClient;
  modelName: string;
  source: string;
  effort?: 'low' | 'medium' | 'high';
  instructions: string;
  tools: ToolSpec[];
  hosted: HostedTool[];
  runId: string;
  autonomy: Autonomy;
  store: RunStore;
  host: ToolHost;
  /** Absolute ms timestamp after which no new work should start. */
  deadline: number;
  /** Don't start a model call later than this (calls can take minutes). */
  modelDeadline?: number;
  step: number;
  maxSteps: number;
  /** Consecutive model-provider failures already retried in earlier ticks without any step completing. */
  modelRetries?: number;
  signal?: AbortSignal;
  log?: (msg: string, extra?: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Consecutive retried model failures (across ticks, with no step completed) before the run fails. */
export const MAX_MODEL_RETRIES = 6;

export type LoopOutcome =
  | { kind: 'completed'; result: string; steps: number }
  | { kind: 'waiting_approval'; approvalId: string; steps: number }
  | { kind: 'waiting_input'; question: string; steps: number }
  /** `retries`: set when yielding to retry a failing model provider (the new consecutive count). */
  | { kind: 'yield'; steps: number; wakeInMs?: number; retries?: number }
  | { kind: 'cancelled'; steps: number }
  | { kind: 'paused'; steps: number }
  | { kind: 'failed'; error: string; code?: string; steps: number };

const OPEN_STATUSES = new Set(['pending', 'awaiting_approval', 'awaiting_input', 'running']);

export async function runLoop(o: LoopOptions): Promise<LoopOutcome> {
  let steps = o.step;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = o.log ?? (() => {});

  for (let guard = 0; guard < 500; guard++) {
    const ctl = await o.store.control();
    if (ctl.cancel) {
      await closeOpenCalls(o, 'cancelled');
      return { kind: 'cancelled', steps };
    }
    if (ctl.pause) return { kind: 'paused', steps };
    if (Date.now() >= o.deadline) return { kind: 'yield', steps };

    const events = await o.store.events();
    if (await saveMissingCalls(o, events)) continue;
    const open = events.filter((e) => e.type === 'tool' && e.runId === o.runId && OPEN_STATUSES.has(String(e.status)));

    // ---------------------------------------------------------- pending tool calls
    if (open.length) {
      for (const [i, ev] of open.entries()) {
        const d = ev.data as ToolCallData;
        if (Date.now() >= o.deadline) return { kind: 'yield', steps };
        // Stop between actions too, not only between model turns.
        if (o.signal?.aborted) {
          await closeOpenCalls(o, 'cancelled');
          return { kind: 'cancelled', steps };
        }
        if (i > 0) {
          const c = await o.store.control();
          if (c.cancel) {
            await closeOpenCalls(o, 'cancelled');
            return { kind: 'cancelled', steps };
          }
          if (c.pause) return { kind: 'paused', steps };
        }

        // Found already running with no resumable handle: the worker died mid-action. Re-running
        // anything that isn't a pure read could repeat a side effect (whatever its approval risk,
        // e.g. a low-risk append in the cloud), so report it and let the agent check.
        if (ev.status === 'running' && !d.background && !isBuiltin(d.name) && !replaySafe(d)) {
          await finish(o, ev, d, {
            output: 'Wren was interrupted while this action was running, so it may or may not have completed. Check the current state before trying it again.',
            isError: true,
          });
          continue;
        }

        if (ev.status === 'awaiting_input') {
          const answer = events.find((e) => e.type === 'message' && (e.seq ?? 0) > (ev.seq ?? 0) && (e.data as MessageData).role === 'user');
          if (!answer) return { kind: 'waiting_input', question: String(d.args.question ?? ''), steps };
          const text = (answer.data as MessageData).text;
          await o.store.update(answer.id, { data: { ...(answer.data as MessageData), answersCallId: d.callId } });
          await finish(o, ev, d, { output: `The user answered: ${text}` });
          continue;
        }

        if (ev.status === 'awaiting_approval') {
          const state = d.approvalId ? await o.store.approvalState(d.approvalId) : 'denied';
          if (state === 'pending') return { kind: 'waiting_approval', approvalId: d.approvalId!, steps };
          if (state !== 'approved') {
            await o.store.update(ev.id, {
              status: 'denied',
              data: { ...d, endedAt: Date.now(), result: { output: state === 'expired' ? 'The approval request expired without an answer; the action was not taken.' : 'The user denied this action. Do not retry it; continue another way or ask the user.', isError: true } },
            });
            continue;
          }
          // Approved: make sure it still acts on the element the user saw.
          if (BROWSER_TARGETED.has(d.name) && d.target) {
            const now = (await o.host.riskContext?.(d.name, d.args).catch(() => undefined))?.browserTarget;
            if (!sameTarget(d.target, now)) {
              await finish(o, ev, d, { output: 'The page changed after this was approved, so the action was not taken. Take a new snapshot and try again.', isError: true });
              continue;
            }
          }
        }

        if (ev.status === 'pending') {
          const ctx = (await o.host.riskContext?.(d.name, d.args).catch(() => undefined)) ?? {};
          if (BROWSER_TARGETED.has(d.name) && ctx.browserTarget) {
            const t = ctx.browserTarget;
            d.target = { label: t.label, role: t.role, inputType: t.inputType, autocomplete: t.autocomplete };
          }
          const a = assessCall(d.name, d.args, o.host.runtime, ctx);
          if (a.blocked) {
            await o.store.update(ev.id, { status: 'error', data: { ...d, risk: a.risk, endedAt: Date.now(), result: { output: a.blocked, isError: true } } });
            continue;
          }
          if (needsApproval(a.risk, o.autonomy) && !isBuiltin(d.name)) {
            const approvalId = await o.store.createApproval({ eventId: ev.id, tool: d.name, title: d.title, risk: a.risk, reason: a.reason, args: d.args });
            await o.store.update(ev.id, { status: 'awaiting_approval', data: { ...d, risk: a.risk, approvalId } });
            return { kind: 'waiting_approval', approvalId, steps };
          }
          if (a.risk !== d.risk) d.risk = a.risk;
        }

        const r = await execute(o, ev, d, log);
        if (r === 'yield') return { kind: 'yield', steps };
        if (r === 'input') return { kind: 'waiting_input', question: String(d.args.question ?? ''), steps };
      }
      continue; // re-read state; all calls of the turn should now be closed
    }

    // ---------------------------------------------------------- model turn
    const last = [...events].reverse().find((e) => e.type === 'message' && e.status !== 'failed');
    const lastIsFinalAnswer =
      last && (last.data as MessageData).role === 'assistant' && last.runId === o.runId && !events.some((e) => e.type === 'tool' && (e.data as ToolCallData).turnId === last.id);
    if (lastIsFinalAnswer && (last!.data as MessageData).raw?.items !== undefined && !(last!.data as { paused?: boolean }).paused) {
      return { kind: 'completed', result: (last!.data as MessageData).text, steps };
    }
    if (steps >= o.maxSteps) {
      await o.store.append<StatusData>('status', { text: `Stopped after ${o.maxSteps} steps. Send a message to let the agent continue.`, level: 'warn', code: 'max_steps' }, 'done');
      return { kind: 'completed', result: 'Stopped at the step limit.', steps };
    }
    if (Date.now() >= (o.modelDeadline ?? o.deadline)) return { kind: 'yield', steps };

    const turn = await modelTurn(o, events, sleep, log);
    if ('error' in turn) {
      if (turn.retryLater) {
        // Retry later with growing gaps, but not forever: the count survives across ticks and
        // only resets once a step completes.
        const retries = (steps > o.step ? 0 : o.modelRetries ?? 0) + 1;
        if (retries >= MAX_MODEL_RETRIES) {
          return { kind: 'failed', error: `The model provider kept failing (${turn.error}). Try again later or choose another model.`, code: turn.code ?? 'model_unavailable', steps };
        }
        const wakeInMs = Math.min(turn.retryLater * 2 ** (retries - 1), 10 * 60_000);
        await o.store.append<StatusData>('status', { text: `The model provider had a problem (${turn.error.slice(0, 200)}). Trying again in ${Math.round(wakeInMs / 60_000)} min.`, level: 'warn', code: 'model_retry' }, 'done');
        return { kind: 'yield', steps, wakeInMs, retries };
      }
      return { kind: 'failed', error: turn.error, code: turn.code, steps };
    }
    steps++;
    if (turn.stop === 'refusal') {
      await o.store.append<StatusData>('status', { text: 'The model declined to continue this task.', level: 'warn', code: 'refusal' }, 'done');
      return { kind: 'completed', result: turn.text || 'The model declined to continue.', steps };
    }
    if (!turn.calls && turn.stop !== 'other') {
      return { kind: 'completed', result: turn.text, steps };
    }
  }
  return { kind: 'yield', steps };
}

/** Re-create tool events for calls a crash left unsaved after their model turn was stored. */
async function saveMissingCalls(o: LoopOptions, events: SessionEvent[]): Promise<boolean> {
  const turn = [...events].reverse().find((e) => e.type === 'message' && e.runId === o.runId && e.status === 'done' && (e.data as MessageData).role === 'assistant');
  const calls = (turn?.data as MessageData | undefined)?.calls;
  if (!turn || !calls?.length) return false;
  const saved = new Set(events.filter((e) => e.type === 'tool' && (e.data as ToolCallData).turnId === turn.id).map((e) => (e.data as ToolCallData).callId));
  const missing = calls.filter((c) => !saved.has(c.callId));
  for (const c of missing) await appendCall(o, turn.id, c);
  return missing.length > 0;
}

async function appendCall(o: LoopOptions, turnId: string, c: NonNullable<MessageData['calls']>[number]) {
  const qualifiedName = `${c.namespace}.${c.name}`;
  const known = o.tools.some((t) => t.namespace === c.namespace && t.name === c.name);
  const data: ToolCallData = { callId: c.callId, name: qualifiedName, args: c.args, title: describeCall(qualifiedName, c.args), risk: 'low', turnId };
  if (c.argsError || !known) {
    await o.store.append<ToolCallData>('tool', { ...data, endedAt: Date.now(), result: { output: c.argsError ?? `Unknown tool "${qualifiedName}".`, isError: true } }, 'error');
  } else {
    await o.store.append<ToolCallData>('tool', data, 'pending');
  }
}

const BROWSER_TARGETED = new Set(['browser.click', 'browser.type', 'browser.press']);

function sameTarget(a: ToolCallData['target'], b: { label?: string; role?: string; inputType?: string } | undefined) {
  return !!b && (a?.label ?? '') === (b.label ?? '') && (a?.role ?? '') === (b.role ?? '') && (a?.inputType ?? '') === (b.inputType ?? '');
}

/** Calls that only read, so repeating one after a crash can't change anything. */
function replaySafe(d: ToolCallData): boolean {
  switch (d.name) {
    case 'computer.read_file':
    case 'computer.list_files':
    case 'computer.shell_status':
    case 'web.fetch':
    case 'browser.snapshot':
    case 'browser.screenshot':
      return true;
    case 'github.request':
      return String(d.args.method ?? 'GET').toUpperCase() === 'GET';
    case 'computer.shell':
      // Judged as on a real computer: the cloud's "it's the agent's own VM" discount doesn't make a write repeatable.
      return assessShell(String(d.args.command ?? ''), 'desktop').risk === 'low';
    default:
      return false;
  }
}

function isBuiltin(name: string) {
  return name.startsWith('task.') || name.startsWith('memory.');
}

async function finish(o: LoopOptions, ev: SessionEvent, d: ToolCallData, result: ToolResult) {
  const capped: ToolResult = { ...result, output: clipMiddle(result.output ?? '', MAX_TOOL_OUTPUT) };
  await o.store.update(ev.id, { status: result.isError ? 'error' : 'done', data: { ...d, endedAt: Date.now(), result: capped, background: undefined } });
}

async function closeOpenCalls(o: LoopOptions, status: 'cancelled') {
  const events = await o.store.events();
  for (const ev of events) {
    if (ev.type === 'tool' && ev.runId === o.runId && OPEN_STATUSES.has(String(ev.status))) {
      const d = ev.data as ToolCallData;
      await o.store.update(ev.id, { status, data: { ...d, endedAt: Date.now(), result: { output: 'Cancelled by the user.', isError: true } } });
    }
  }
}

async function execute(o: LoopOptions, ev: SessionEvent, d: ToolCallData, log: (m: string, e?: unknown) => void): Promise<'done' | 'yield' | 'input'> {
  const name = d.name;
  const startedAt = d.startedAt ?? Date.now();
  if (ev.status !== 'running') await o.store.update(ev.id, { status: 'running', data: { ...d, startedAt } });
  d.startedAt = startedAt;

  // Built-in task and memory tools run here, independent of the host.
  try {
    switch (name) {
      case 'task.update_plan': {
        const items = Array.isArray(d.args.items) ? (d.args.items as PlanItem[]).slice(0, 30) : [];
        await o.store.append('plan', { items }, 'done');
        await finish(o, ev, d, { output: 'Plan shown to the user.' });
        return 'done';
      }
      case 'task.ask_user': {
        const q = String(d.args.question ?? '').slice(0, 2000);
        await o.store.update(ev.id, { status: 'awaiting_input', data: d });
        await o.store.notify('Your agent has a question', q, 'question');
        return 'input';
      }
      case 'task.notify': {
        await o.store.notify(String(d.args.title ?? 'Update').slice(0, 120), String(d.args.body ?? '').slice(0, 1000), 'agent');
        await finish(o, ev, d, { output: 'Notification sent.' });
        return 'done';
      }
      case 'memory.remember': {
        const fact = String(d.args.fact ?? '').trim().slice(0, 600);
        if (!fact) {
          await finish(o, ev, d, { output: 'Nothing to remember.', isError: true });
          return 'done';
        }
        const id = await o.store.memory.add(fact);
        await finish(o, ev, d, { output: `Saved memory ${id}.` });
        return 'done';
      }
      case 'memory.forget': {
        const ok = await o.store.memory.remove(String(d.args.id ?? ''));
        await finish(o, ev, d, { output: ok ? 'Memory deleted.' : 'No memory with that id.', isError: !ok });
        return 'done';
      }
    }

    const ctx: ToolContext = {
      runtime: o.host.runtime,
      deadline: o.deadline,
      signal: o.signal,
      callId: d.callId,
      expect: d.target,
      isCancelled: async () => (await o.store.control()).cancel,
      checkpoint: async (background) => {
        d.background = background;
        await o.store.update(ev.id, { status: 'running', data: { ...d } });
      },
    };
    const result = await o.host.execute(name, d.args, ctx, d.background);
    if ('yield' in result) return 'yield';
    await finish(o, ev, d, result);
    return 'done';
  } catch (e) {
    log('tool failed', { name, error: (e as Error).message });
    await finish(o, ev, d, { output: `Tool error: ${(e as Error).message}`, isError: true });
    return 'done';
  }
}

interface TurnSummary {
  text: string;
  calls: number;
  stop: string;
}

async function modelTurn(
  o: LoopOptions,
  events: SessionEvent[],
  sleep: (ms: number) => Promise<void>,
  log: (m: string, e?: unknown) => void,
): Promise<TurnSummary | { error: string; code?: string; retryLater?: number }> {
  const msg = await o.store.append<MessageData>('message', { role: 'assistant', text: '', model: o.modelName, source: o.source }, 'streaming');
  let text = '';
  let lastFlush = 0;
  let flushing: Promise<void> | null = null;
  let thinking = '';
  const flush = (force = false) => {
    const now = Date.now();
    if (!force && (now - lastFlush < 350 || flushing)) return;
    lastFlush = now;
    const snapshot = { role: 'assistant' as const, text, model: o.modelName, source: o.source, ...(thinking ? { thinking: thinking.slice(-600) } : {}) };
    flushing = o.store.update(msg.id, { data: snapshot }).catch(() => {}).finally(() => {
      flushing = null;
    });
  };

  const delays = [2000, 6000, 15000];
  for (let attempt = 0; ; attempt++) {
    try {
      text = '';
      const turn = await o.model.stream(
        {
          model: o.modelName,
          instructions: o.instructions,
          events: events.filter((e) => e.id !== msg.id),
          tools: o.tools,
          hosted: o.hosted,
          effort: o.effort,
          signal: o.signal,
        },
        (e) => {
          if (e.type === 'text') {
            text += e.delta;
            flush();
          } else if (e.type === 'reasoning') {
            thinking += e.delta;
            flush();
          }
        },
      );
      if (flushing) await flushing;
      await o.store.recordUsage(turn.usage, o.modelName).catch(() => {});
      const finalData: MessageData & { paused?: boolean; webSearches?: number } = {
        role: 'assistant',
        text: turn.text,
        raw: turn.raw,
        model: o.modelName,
        source: o.source,
        ...(turn.stopReason === 'other' ? { paused: true } : {}),
        ...(turn.webSearches ? { webSearches: turn.webSearches } : {}),
        ...(turn.toolCalls.length ? { calls: turn.toolCalls.map((c) => ({ callId: c.callId, namespace: c.namespace, name: c.name, args: c.args, ...(c.argsError ? { argsError: c.argsError } : {}) })) } : {}),
      };
      await o.store.update(msg.id, { status: 'done', data: finalData });
      for (const c of turn.toolCalls) await appendCall(o, msg.id, c);
      return { text: turn.text, calls: turn.toolCalls.length, stop: turn.stopReason };
    } catch (e) {
      const err = e as ModelError;
      log('model error', { message: err.message, status: err.status, code: err.code });
      if (err.retryable && attempt < delays.length && Date.now() + delays[attempt] < o.deadline) {
        await sleep(delays[attempt]);
        continue;
      }
      if (flushing) await flushing;
      await o.store.update(msg.id, { status: 'failed', data: { role: 'assistant', text, model: o.modelName, source: o.source } });
      if (err.retryable) return { error: err.message, code: err.code, retryLater: 60_000 };
      return { error: friendlyModelError(err), code: err.code };
    }
  }
}

export function friendlyModelError(err: { message: string; status?: number; code?: string }): string {
  const c = err.code ?? '';
  if (c === 'subscription_sharing_usage_limit_exceeded') return 'Your ChatGPT plan usage limit for this app was reached. Review it in ChatGPT Settings → Usage, then resume.';
  if (c === 'subscription_sharing_user_not_eligible') return 'ChatGPT plan usage is not available for this account or workspace.';
  if (c === 'insufficient_quota') return 'The API key has run out of credits or quota.';
  if (err.status === 401 || c === 'authentication_error' || c === 'invalid_api_key') return 'The model provider rejected the credentials. Reconnect the account in Connections.';
  if (err.status === 403 || c === 'permission_error') return `The model provider refused the request: ${err.message}`;
  if (err.status === 404 || c === 'not_found_error' || c === 'model_not_found') return `The selected model isn't available to this account: ${err.message}`;
  return err.message;
}
