import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { assessCall, describeCall, needsApproval, type Autonomy, type LoopOutcome, type MessageData, type PlanItem, type Risk, type StatusData, type ToolCallData } from '@wren/core';
import type { RemoteStore } from '../main/remote';
import { dataDir } from '../main/config';
import { allowedRoots } from '../main/paths';
import { killTree, tracked, treeAlive } from '../main/proctree';
import { engineProfile, hasSeatbelt, seatbeltProfile, type Engine } from '../main/sandbox';
import { agentEnv, SHELL_PREFIX, toolEnv } from '../main/shellenv';
import { currentProgramTrust } from '../main/trust';

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
  /** This computer's switches (Settings → This computer); engines must respect them too. */
  allow: { shell: boolean; browser: boolean; screen: boolean };
  resumeId?: string;
  /** The task's latest plan, for an engine that continues its own to-do list across turns. */
  plan?: PlanItem[];
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

/**
 * What each engine CLI may take from Wren's environment beyond the agent allowlist (agentEnv): its
 * own sign-in and provider settings, and how to reach the network. Never Wren's session state, and
 * nothing else Wren was started with (tokens for other services, startup hooks, W-108).
 */
const ENGINE_VARS: Record<Engine, RegExp> = {
  'claude-code': /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_VERTEX_PROJECT_ID|ANTHROPIC_MODEL|CLAUDE_CONFIG_DIR|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|AWS_[A-Z_]+|CLOUD_ML_REGION|GOOGLE_APPLICATION_CREDENTIALS)$/,
  'grok-build': /^(GROK_[A-Z_]+|XAI_[A-Z_]+)$/,
};
const NETWORK_VARS = /^(HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|all_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME|XDG_STATE_HOME)$/;

/** Environment for an engine process: the user's own login for that CLI, never our session state. */
export function engineEnv(engine: Engine): NodeJS.ProcessEnv {
  const env = agentEnv(process.env, {});
  delete env.WREN_AGENT;
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (ENGINE_VARS[engine].test(k) || NETWORK_VARS.test(k))) env[k] = v;
  const sep = process.platform === 'win32' ? ';' : ':';
  const pathKey = Object.keys(env).find((k) => /^path$/i.test(k)) ?? 'PATH';
  env[pathKey] = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', env[pathKey] ?? ''].join(sep);
  return env;
}

/**
 * Start an engine CLI. On macOS it runs inside a Seatbelt profile (the allowed folders,
 * toolchains and the CLI's own state), and so does every command it runs: its shell tool
 * can't read or change files outside the allowed folders any more than Wren's own can.
 * `helper` is this app's script the CLI starts for approvals (it must stay readable).
 */
export async function spawnEngine(engine: Engine, cli: string, args: string[], run: EngineRun, helper: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<ChildProcessWithoutNullStreams> {
  const env = { ...engineEnv(engine), ...extraEnv };
  if (!hasSeatbelt()) return track(spawn(cli, args, { cwd: run.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }));
  Object.assign(env, await toolEnv());
  const profile = engineProfile(engine, allowedRoots(run.folders), dataDir(), appPaths(helper));
  return track(spawn('/usr/bin/sandbox-exec', ['-p', profile, cli, ...args], { cwd: run.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }));
}

// Engine CLIs run as the leader of their own process group (detached), so stopping one also stops
// every command and server it started. They stay tracked until nothing of theirs is left running.
const engines = new Set<ChildProcess>();

function track<P extends ChildProcess>(p: P): P {
  engines.add(tracked(p));
  p.on('close', () => {
    void treeAlive(p).then((alive) => {
      if (!alive) engines.delete(p);
    });
  });
  return p;
}

/** Stop an engine CLI and everything it started; resolves whether that is confirmed. */
export async function stopEngine(p: ChildProcess, graceMs = 3000): Promise<boolean> {
  const ok = await killTree(p, graceMs).catch(() => false);
  if (ok) engines.delete(p);
  return ok;
}

/** Stop every engine CLI process tree (for an update); true once all are confirmed gone. */
export async function stopAllEngines(): Promise<boolean> {
  const done = await Promise.all([...engines].map((p) => stopEngine(p, 1000)));
  return done.every(Boolean);
}

/** Paths commands need to read to start this app's helpers (e.g. the approval MCP server). */
function appPaths(helper: string): string[] {
  const appBundle = process.platform === 'darwin' ? resolve(process.execPath, '..', '..', '..') : dirname(process.execPath);
  return [appBundle, dirname(helper)];
}

function shellPrefix(): string {
  const dir = join(dataDir(), 'bin');
  const file = join(dir, 'wren-shell.sh');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let current = '';
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    /* first run */
  }
  if (current !== SHELL_PREFIX) writeFileSync(file, SHELL_PREFIX, { mode: 0o700 });
  chmodSync(file, 0o700);
  return file;
}

let restrictedSupport: { cli: string; ok: boolean } | null = null;
/** Claude Code's --restricted mode (2.1.2xx+): no settings files, file tools confined to the working folders. */
export function claudeSupportsRestricted(cli: string): boolean {
  if (restrictedSupport?.cli !== cli) {
    const help = spawnSync(cli, ['--help'], { encoding: 'utf8', env: engineEnv('claude-code'), timeout: 20_000 });
    restrictedSupport = { cli, ok: /--restricted\b/.test(`${help.stdout}${help.stderr}`) };
  }
  return restrictedSupport.ok;
}

/**
 * Start Claude Code. It runs as the user's own `claude` (its sign-in stays in the user's
 * Keychain, untouched by agent commands) in --restricted mode, and on macOS every command or MCP
 * server it starts goes through Wren's shell sandbox via CLAUDE_CODE_SHELL_PREFIX: commands reach
 * the allowed folders and toolchains only, never the Keychain or Claude's own settings.
 */
export async function spawnClaude(cli: string, args: string[], run: EngineRun, helper: string): Promise<ChildProcessWithoutNullStreams> {
  const env: NodeJS.ProcessEnv = { ...engineEnv('claude-code') };
  if (hasSeatbelt()) {
    Object.assign(env, await toolEnv(), {
      SHELL: /^\/bin\/(zsh|bash)$/.test(process.env.SHELL ?? '') ? process.env.SHELL : '/bin/zsh',
      CLAUDE_CODE_SHELL_PREFIX: shellPrefix(),
      WREN_SHELL_SB: seatbeltProfile(allowedRoots(run.folders), dataDir(), undefined, appPaths(helper)),
    });
  }
  return track(spawn(cli, args, { cwd: run.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }));
}

export class TimelineWriter {
  private msgId: string | null = null;
  private text = '';
  private lastFlush = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  readonly tools = new Map<string, { id: string; data: ToolCallData; status?: string }>();

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

  /**
   * The open timeline entry for the same action under the other id. A permission prompt can
   * arrive before or after the engine reports the tool call, and not always with its id.
   */
  matchOpen(name: string, title: string, synthetic: boolean): string | undefined {
    for (const [id, t] of this.tools) {
      if (t.data.endedAt || t.data.name !== name || t.data.title !== title) continue;
      if (/^(perm|hook)-/.test(id) === synthetic) return id;
    }
  }

  /** Entries being created, so the stream and a permission prompt for the same call share one. */
  private starting = new Map<string, Promise<string>>();

  async toolStart(callId: string, name: string, args: Record<string, unknown>, title?: string): Promise<string> {
    const known = this.tools.get(callId);
    if (known) return known.id;
    const pending = this.starting.get(callId);
    if (pending) return pending;
    const p = this.createTool(callId, name, args, title).finally(() => this.starting.delete(callId));
    this.starting.set(callId, p);
    return p;
  }

  private async createTool(callId: string, name: string, args: Record<string, unknown>, title?: string): Promise<string> {
    await this.endMessage();
    // Already shown by its permission prompt: keep that entry and track it by the real id.
    const prompted = this.matchOpen(name, title ?? describeCall(name, args), true);
    if (prompted) {
      const t = this.tools.get(prompted)!;
      this.tools.delete(prompted);
      this.tools.set(callId, t);
      return t.id;
    }
    const data: ToolCallData = { callId, name, args, title: title ?? describeCall(name, args), risk: 'low', engine: true, startedAt: Date.now() };
    const ev = await this.store.append<ToolCallData>('tool', data, 'running');
    this.tools.set(callId, { id: ev.id, data });
    return ev.id;
  }

  /**
   * Change a step's status and data, keeping this copy in step (toolEnd writes it back). Takes the
   * step itself: its key can change meanwhile (a permission prompt's entry gets the call's real id).
   */
  async setStep(t: { id: string; data: ToolCallData; status?: string }, status: string, patch: Partial<ToolCallData>) {
    t.data = { ...t.data, ...patch };
    t.status = status;
    await this.store.update(t.id, { status, data: t.data });
  }

  async toolEnd(callId: string, output: string, isError: boolean) {
    const t = this.tools.get(callId);
    // A denied step has already ended: the engine's "denied" result mustn't turn it into a failure.
    if (!t || t.status === 'denied') return;
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
  if (call.name === 'computer.shell' && !run.allow.shell) return { allow: false, message: 'Blocked by Wren: terminal access is turned off on this computer (Wren → Settings → This computer).' };
  if (call.name.startsWith('browser.') && !run.allow.browser) return { allow: false, message: 'Blocked by Wren: browser use is turned off on this computer.' };
  if (call.name.startsWith('screen.') && !run.allow.screen) return { allow: false, message: 'Blocked by Wren: screen capture is turned off on this computer.' };
  // On macOS the engine (and everything it runs) is inside Wren's sandbox; elsewhere it isn't.
  const a = assessCall(call.name, call.args, 'desktop', { unsandboxed: !hasSeatbelt(), trustedProgram: call.name === 'computer.shell' ? await currentProgramTrust(allowedRoots(run.folders)) : undefined });
  if (a.blocked) return { allow: false, message: a.blocked };
  if (!needsApproval(a.risk as Risk, run.autonomy)) return { allow: true };
  let t = writer.tools.get(call.callId);
  if (!t && /^(perm|hook)-/.test(call.callId)) {
    const shown = writer.matchOpen(call.name, call.title, false);
    if (shown) t = writer.tools.get(shown);
  }
  if (!t) {
    await writer.toolStart(call.callId, call.name, call.args, call.title);
    t = writer.tools.get(call.callId)!;
  }
  // Through the writer, so the step's risk and approval stay on it when the engine reports the result.
  const step = t;
  await writer.setStep(step, 'awaiting_approval', { risk: a.risk });
  const approvalId = await run.store.createApproval({ eventId: step.id, tool: call.name, title: call.title, risk: a.risk, reason: a.reason, args: call.args });
  await writer.setStep(step, 'awaiting_approval', { approvalId });
  // Engines treat a hook timeout as "allow", so always answer well before theirs.
  const giveUpAt = Date.now() + 50 * 60_000;
  for (;;) {
    if (run.signal.aborted) return { allow: false, message: 'Stopped by the user.' };
    if (Date.now() > giveUpAt) return { allow: false, message: 'No approval arrived in time, so the action was not taken. Ask the user and try again later.' };
    const state = await run.store.approvalState(approvalId).catch(() => 'pending' as const);
    if (state === 'approved') {
      await writer.setStep(step, 'running', {});
      return { allow: true };
    }
    if (state !== 'pending') {
      await writer.setStep(step, 'denied', { endedAt: Date.now(), result: { output: 'Denied by the user.', isError: true } });
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
