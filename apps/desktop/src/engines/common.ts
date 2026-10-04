import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assessCall, describeCall, needsApproval, type Autonomy, type LoopOutcome, type MessageData, type Risk, type StatusData, type ToolCallData } from '@wren/core';
import type { RemoteStore } from '../main/remote';

// Shared plumbing for external agent engines (Claude Code, Grok Build): they
// run their own loop, Wren mirrors what they do into the task timeline and
// answers their permission prompts with Wren approvals.

export interface EngineRun {
  runId: string;
  store: RemoteStore;
  agentName: string;
  autonomy: Autonomy;
  instructions: string;
  model: string;
  prompt: string;
  cwd: string;
  folders: string[];
  resumeId?: string;
  signal: AbortSignal;
  /** Remembered engine session id for follow-ups in the same Wren task. */
  saveResumeId: (id: string) => Promise<void>;
}

/** Locate an engine CLI the user installed themselves. */
export function findCli(name: 'claude' | 'grok'): string | null {
  const home = homedir();
  const candidates =
    process.platform === 'win32'
      ? [join(home, '.local', 'bin', `${name}.exe`), join(home, `.${name}`, 'bin', `${name}.exe`), join(home, 'AppData', 'Roaming', 'npm', `${name}.cmd`)]
      : [join(home, '.local', 'bin', name), join(home, `.${name}`, 'bin', name), '/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, join(home, '.npm-global', 'bin', name)];
  for (const c of candidates) if (existsSync(c)) return c;
  const which = spawnSync(process.platform === 'win32' ? 'where' : '/bin/bash', process.platform === 'win32' ? [name] : ['-lc', `command -v ${name}`], { encoding: 'utf8' });
  const p = which.stdout?.trim().split('\n')[0];
  return p && existsSync(p) ? p : null;
}

/** Environment for engine processes: the user's own login, never our session state. */
export function engineEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|ELECTRON_|WREN_)/.test(k) || k === 'ANTHROPIC_BASE_URL') delete env[k];
  }
  env.PATH = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH ?? ''].join(process.platform === 'win32' ? ';' : ':');
  return env;
}

export class TimelineWriter {
  private msgId: string | null = null;
  private text = '';
  private lastFlush = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  readonly tools = new Map<string, { id: string; data: ToolCallData }>();

  constructor(
    private readonly store: RemoteStore,
    private readonly source: string,
    private readonly model: string,
  ) {}

  async textDelta(delta: string) {
    if (!delta) return;
    if (!this.msgId) {
      const ev = await this.store.append<MessageData>('message', { role: 'assistant', text: '', model: this.model, source: this.source }, 'streaming');
      this.msgId = ev.id;
    }
    this.text += delta;
    if (Date.now() - this.lastFlush > 400) await this.flush();
    else if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flush(), 450);
  }

  private async flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.lastFlush = Date.now();
    if (this.msgId) await this.store.update(this.msgId, { data: { role: 'assistant', text: this.text, model: this.model, source: this.source } }).catch(() => {});
  }

  /** Close the current assistant message (before a tool call or at the end). */
  async endMessage(finalText?: string) {
    if (finalText !== undefined && !this.msgId && finalText.trim()) {
      await this.store.append<MessageData>('message', { role: 'assistant', text: finalText, model: this.model, source: this.source, raw: { format: 'chat', items: [] } }, 'done');
      return;
    }
    if (!this.msgId) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.store.update(this.msgId, { status: 'done', data: { role: 'assistant', text: finalText ?? this.text, model: this.model, source: this.source, raw: { format: 'chat', items: [] } } });
    this.msgId = null;
    this.text = '';
  }

  async toolStart(callId: string, name: string, args: Record<string, unknown>, title?: string) {
    await this.endMessage();
    const data: ToolCallData = { callId, name, args, title: title ?? describeCall(name, args), risk: 'low', engine: true, startedAt: Date.now() };
    const ev = await this.store.append<ToolCallData>('tool', data, 'running');
    this.tools.set(callId, { id: ev.id, data });
    return ev.id;
  }

  async toolEnd(callId: string, output: string, isError: boolean) {
    const t = this.tools.get(callId);
    if (!t) return;
    t.data = { ...t.data, endedAt: Date.now(), result: { output: output.slice(0, 30000), isError } };
    await this.store.update(t.id, { status: isError ? 'error' : 'done', data: t.data });
  }

  async status(text: string, level: StatusData['level'] = 'info', code?: string) {
    await this.store.append<StatusData>('status', { text, level, ...(code ? { code } : {}) }, 'done');
  }

  get currentText() {
    return this.text;
  }
}

/**
 * Decide an engine permission request with Wren's policy: allow low-risk calls,
 * ask the user (approval) when the agent's autonomy requires it, block the rest.
 */
export async function decide(
  run: EngineRun,
  writer: TimelineWriter,
  call: { callId: string; name: string; args: Record<string, unknown>; title: string; paths?: string[] },
  inFolders: (p: string) => boolean,
): Promise<{ allow: boolean; message?: string }> {
  for (const p of call.paths ?? []) if (!inFolders(p)) return { allow: false, message: `Blocked by Wren: ${p} is outside the folders allowed on this computer.` };
  const a = assessCall(call.name, call.args, 'desktop', { unsandboxed: process.platform === 'win32' });
  if (a.blocked) return { allow: false, message: a.blocked };
  if (!needsApproval(a.risk as Risk, run.autonomy)) return { allow: true };
  let t = writer.tools.get(call.callId);
  if (!t) {
    await writer.toolStart(call.callId, call.name, call.args, call.title);
    t = writer.tools.get(call.callId)!;
  }
  await run.store.update(t.id, { status: 'awaiting_approval', data: { ...t.data, risk: a.risk } });
  const approvalId = await run.store.createApproval({ eventId: t.id, tool: call.name, title: call.title, risk: a.risk, reason: a.reason, args: call.args });
  await run.store.update(t.id, { status: 'awaiting_approval', data: { ...t.data, risk: a.risk, approvalId } });
  // Engines treat a hook timeout as "allow", so always answer well before theirs.
  const giveUpAt = Date.now() + 50 * 60_000;
  for (;;) {
    if (run.signal.aborted) return { allow: false, message: 'Stopped by the user.' };
    if (Date.now() > giveUpAt) return { allow: false, message: 'No approval arrived in time, so the action was not taken. Ask the user and try again later.' };
    const state = await run.store.approvalState(approvalId).catch(() => 'pending' as const);
    if (state === 'approved') {
      await run.store.update(t.id, { status: 'running', data: { ...t.data, risk: a.risk, approvalId } });
      return { allow: true };
    }
    if (state !== 'pending') {
      await run.store.update(t.id, { status: 'denied', data: { ...t.data, risk: a.risk, approvalId, endedAt: Date.now(), result: { output: 'Denied by the user.', isError: true } } });
      return { allow: false, message: 'The user denied this action. Do not retry it; continue another way or explain what you need.' };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export type BridgeHandler = (req: { tool_name: string; input: Record<string, unknown>; tool_use_id?: string }) => Promise<{ allow: boolean; message?: string }>;

/** Localhost endpoint that engine permission hooks call back into (per-run bearer token). */
export async function startApprovalBridge(handler: BridgeHandler): Promise<{ url: string; token: string; close: () => void }> {
  const token = randomBytes(24).toString('hex');
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) {
      res.statusCode = 403;
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      res.setHeader('content-type', 'application/json');
      try {
        const r = JSON.parse(body);
        const d = await handler({ tool_name: String(r.tool_name ?? 'unknown'), input: (r.input ?? {}) as Record<string, unknown>, tool_use_id: r.tool_use_id });
        res.end(JSON.stringify(d.allow ? { behavior: 'allow', updatedInput: r.input } : { behavior: 'deny', message: d.message ?? 'Denied.' }));
      } catch (e) {
        res.end(JSON.stringify({ behavior: 'deny', message: `Wren could not evaluate this action: ${(e as Error).message}` }));
      }
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/approve`, token, close: () => server.close() };
}

export type { LoopOutcome };
