import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { agentAnswerText, assessCall, describeCall, needsApproval, type AskableAgent, type Autonomy, type Effort, type LoopOutcome, type MessageData, type PlanItem, type Risk, type StatusData, type ToolCallData } from '@wren/core';
import type { RemoteStore } from '../main/remote';
import type { EngineImage } from './images';
import { dataDir } from '../main/config';
import { allowedRoots, reachesAny } from '../main/paths';
import { killTree, tracked, treeAlive } from '../main/proctree';
import { autorunPaths, enginePrivatePaths, engineProfile, hasSeatbelt, seatbeltProfile, type Engine } from '../main/sandbox';
import { agentEnv, SHELL_PREFIX, toolEnv, userPathDirs } from '../main/shellenv';
import { currentProgramTrust } from '../main/trust';

// Shared plumbing for external agent engines (Claude Code, Grok Build): they
// run their own loop, Wren mirrors what they do into the task timeline and
// answers their permission prompts with Wren approvals.

export interface EngineRun {
  runId: string;
  /** Which CLI runs it: decides which engine state counts as its own. */
  engine: Engine;
  store: RemoteStore;
  agentName: string;
  autonomy: Autonomy;
  instructions: string;
  model: string;
  /** How hard the model thinks (the agent's Effort setting); unset leaves the CLI's own default. */
  effort?: Effort;
  prompt: string;
  /** Images the user attached to the messages in `prompt`. */
  images?: EngineImage[];
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
  /** The user's other agents this one may ask (its ask_agent tool); none for a task another agent asked. */
  askable?: AskableAgent[];
}

/**
 * Every copy of an engine CLI the user installed themselves, in the order they'd be looked up: the usual
 * install places, then the user's PATH as read from their login shell once (no shell is run for this, W-183).
 * Which one Wren may start is decided by `engineProgram` (engines/program.ts).
 */
export function findClis(name: 'claude' | 'grok'): string[] {
  const home = homedir();
  const candidates =
    process.platform === 'win32'
      ? [join(home, '.local', 'bin', `${name}.exe`), join(home, `.${name}`, 'bin', `${name}.exe`), join(home, 'AppData', 'Roaming', 'npm', `${name}.cmd`)]
      : [join(home, '.local', 'bin', name), join(home, `.${name}`, 'bin', name), '/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, join(home, '.npm-global', 'bin', name)];
  const exts = process.platform === 'win32' ? ['.exe', '.cmd'] : [''];
  for (const d of userPathDirs()) for (const x of exts) candidates.push(join(d, name + x));
  return [...new Set(candidates)].filter((c) => existsSync(c));
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
export async function spawnEngine(engine: Engine, cli: string, args: string[], run: EngineRun, helper: string, extraEnv: NodeJS.ProcessEnv = {}, privateRead: string[] = []): Promise<ChildProcessWithoutNullStreams> {
  const env = { ...engineEnv(engine), ...extraEnv };
  if (!hasSeatbelt()) return track(spawn(cli, args, { cwd: run.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }));
  Object.assign(env, await toolEnv());
  const profile = engineProfile(engine, allowedRoots(run.folders), dataDir(), appPaths(helper), undefined, privateRead);
  return track(spawn('/usr/bin/sandbox-exec', ['-p', profile, cli, ...args], { cwd: run.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }));
}

// Engine CLIs run as the leader of their own process group (detached), so stopping one also stops
// every command and server it started. They stay tracked until nothing of theirs is left running.
export const engines = new Set<ChildProcess>();

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

/**
 * After an engine's turn: stop whatever is left of its process tree (commands it left running too). If
 * that can't be confirmed, the task says so (W-126) and Wren keeps watching, without signalling again: the
 * group's number could belong to another program once it's gone (W-130). When it's gone, or anyone else
 * (quit, an update) confirms the stop, the engine is no longer tracked; until then quitting or updating
 * still tries to stop it.
 */
export async function finishEngine(
  p: ChildProcess,
  writer: { status: TimelineWriter['status'] },
  stop: (p: ChildProcess) => Promise<boolean> = stopEngine,
  alive: (p: ChildProcess) => Promise<boolean> = treeAlive,
): Promise<boolean> {
  if (await stop(p)) return true;
  await writer.status('Wren couldn’t confirm that this engine’s processes stopped. It keeps checking, and quitting or updating Wren tries to stop them again.', 'warn').catch(() => {});
  const watch = setInterval(() => {
    if (!engines.has(p)) return clearInterval(watch); // someone else confirmed it
    void alive(p).then(
      (still) => {
        if (!still) {
          engines.delete(p);
          clearInterval(watch);
        }
      },
      () => {},
    );
  }, 15_000);
  watch.unref();
  return false;
}

/** Stop every engine CLI process tree (for an update); true once all are confirmed gone. */
export async function stopAllEngines(): Promise<boolean> {
  const done = await Promise.all([...engines].map((p) => stopEngine(p, 1000)));
  return done.every(Boolean);
}

/** Paths commands need to read to start this app's helpers (e.g. the approval MCP server). */
export function appPaths(helper: string): string[] {
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

const helpTexts = new Map<string, string>();
/** An engine CLI's help text (Grok's for agent mode), read once per program: which flags this version has. */
function cliHelp(engine: Engine, cli: string): string {
  // Keyed by the file the link points to: an update installs a new version and moves the link.
  let key = cli;
  try {
    key = realpathSync(cli);
  } catch {
    /* keep the path */
  }
  let text = helpTexts.get(key);
  if (text === undefined) {
    const help = spawnSync(cli, engine === 'claude-code' ? ['--help'] : ['agent', '--help'], { encoding: 'utf8', env: engineEnv(engine), timeout: 20_000 });
    text = `${help.stdout ?? ''}${help.stderr ?? ''}`;
    helpTexts.set(key, text);
  }
  return text;
}

/** Whether this version of the CLI has a command-line flag (from its help text). */
export function cliHasFlag(engine: Engine, cli: string, flag: string): boolean {
  return new RegExp(`(^|\\s)${flag}\\b`, 'm').test(cliHelp(engine, cli));
}

/** Claude Code's --restricted mode (2.1.2xx+): no settings files, file tools confined to the working folders. */
export function claudeSupportsRestricted(cli: string): boolean {
  return cliHasFlag('claude-code', cli, '--restricted');
}

/**
 * The flag that sets how hard the CLI's model thinks: Claude Code `--effort` (low to max), Grok Build
 * `--reasoning-effort` (none to max). Null for a version without it, which then keeps its own default.
 */
export function effortFlag(engine: Engine, cli: string): string | null {
  const flag = engine === 'claude-code' ? '--effort' : '--reasoning-effort';
  return cliHasFlag(engine, cli, flag) ? flag : null;
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
  // Wren's own MCP calls wait for a person (an approval) or another agent (an answer): longer than any wait.
  if (run.askable?.length) env.MCP_TOOL_TIMEOUT = String(ASK_WAIT_MS + 5 * 60_000);
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

  /**
   * `keepMessage`: a step from a permission prompt for a call the stream hasn't shown (a background
   * sub-agent's), which can come while the agent is still writing: its message stays whole.
   */
  async toolStart(callId: string, name: string, args: Record<string, unknown>, title?: string, keepMessage = false): Promise<string> {
    const known = this.tools.get(callId);
    if (known) {
      // The stream reporting a call its permission prompt already showed: that's still where the agent's
      // message ends (W-132).
      if (!keepMessage) await this.endMessage();
      return known.id;
    }
    const pending = this.starting.get(callId);
    if (pending) {
      if (!keepMessage) await this.endMessage();
      return pending;
    }
    const p = this.createTool(callId, name, args, title, keepMessage).finally(() => this.starting.delete(callId));
    this.starting.set(callId, p);
    return p;
  }

  private async createTool(callId: string, name: string, args: Record<string, unknown>, title: string | undefined, keepMessage: boolean): Promise<string> {
    if (!keepMessage) await this.endMessage();
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
    // A denied or withdrawn step has already ended: the engine's refusal mustn't turn it into a failure.
    if (!t || t.status === 'denied' || t.status === 'cancelled') return;
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
  /** The asker's own lifetime (the permission prompt's connection): once it's gone, nothing is allowed. */
  asker?: AbortSignal,
): Promise<{ allow: boolean; message?: string }> {
  // A stopped run allows nothing, even what wouldn't need approval (W-122); neither does an asker that left.
  const over = () => run.signal.aborted || !!asker?.aborted;
  const stopped = { allow: false, message: 'Stopped by the user.' };
  if (over()) return stopped;
  // Never Wren itself, a credential store or another engine's state, even inside an allowed folder (W-177).
  if (call.paths?.length) {
    const priv = enginePrivatePaths(run.engine, dataDir());
    const base = allowedRoots(run.folders)[0] ?? homedir();
    for (const p of call.paths) if (reachesAny(p, base, priv)) return { allow: false, message: `Blocked by Wren: ${p} is part of Wren itself, a credential store or another app's sign-in, which agents never use.` };
    // Nor, for anything but reading, a file that makes programs run later outside the sandbox.
    if (call.name !== 'computer.read_file' && call.name !== 'computer.list_files') {
      for (const p of call.paths) if (reachesAny(p, base, autorunPaths(homedir(), allowedRoots(run.folders)))) return { allow: false, message: `Blocked by Wren: ${p} makes programs run later outside Wren's sandbox (when you open a terminal, use git or log in), so agents never change it.` };
    }
  }
  for (const p of call.paths ?? []) if (!inFolders(p)) return { allow: false, message: `Blocked by Wren: ${p} is outside the folders allowed on this computer.` };
  if (call.name === 'computer.shell' && !run.allow.shell) return { allow: false, message: 'Blocked by Wren: terminal access is turned off on this computer (Wren → Settings → This computer).' };
  if (call.name.startsWith('browser.') && !run.allow.browser) return { allow: false, message: 'Blocked by Wren: browser use is turned off on this computer.' };
  if (call.name.startsWith('screen.') && !run.allow.screen) return { allow: false, message: 'Blocked by Wren: screen capture is turned off on this computer.' };
  // On macOS the engine (and everything it runs) is inside Wren's sandbox; elsewhere it isn't.
  const a = assessCall(call.name, call.args, 'desktop', { unsandboxed: !hasSeatbelt(), trustedProgram: call.name === 'computer.shell' ? await currentProgramTrust(allowedRoots(run.folders)) : undefined });
  if (a.blocked) return { allow: false, message: a.blocked };
  if (!needsApproval(a.risk as Risk, run.autonomy)) return over() ? stopped : { allow: true };
  let t = writer.tools.get(call.callId);
  // A step only takes the approval for the same kind of action: a request naming another call's id can't
  // take over that step (W-121). A generic engine step (the stream didn't say what kind of tool) can.
  if (t && t.data.name !== call.name && !/^(grok|claude)\./.test(t.data.name)) {
    t = undefined;
    call = { ...call, callId: `perm-${randomBytes(6).toString('hex')}` };
  }
  if (!t && /^(perm|hook)-/.test(call.callId)) {
    const shown = writer.matchOpen(call.name, call.title, false);
    if (shown) t = writer.tools.get(shown);
  }
  if (!t) {
    await writer.toolStart(call.callId, call.name, call.args, call.title, true);
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
    if (over()) {
      // Nobody waits for this answer any more: the approval is withdrawn (denied), not left to be granted.
      await run.store.withdrawApproval?.(approvalId).catch(() => {});
      // Shown as stopped, not as something the user denied.
      await writer.setStep(step, 'cancelled', { endedAt: Date.now(), result: { output: 'Withdrawn: the task stopped or the request was cancelled.', isError: true } });
      return stopped;
    }
    if (Date.now() > giveUpAt) return { allow: false, message: 'No approval arrived in time, so the action was not taken. Ask the user and try again later.' };
    const state = await run.store.approvalState(approvalId).catch(() => 'pending' as const);
    if (state === 'approved') {
      if (over()) return stopped;
      await writer.setStep(step, 'running', {});
      return over() ? stopped : { allow: true }; // a Stop during that write still counts (W-122)
    }
    if (state !== 'pending') {
      await writer.setStep(step, 'denied', { endedAt: Date.now(), result: { output: 'Denied by the user.', isError: true } });
      return { allow: false, message: 'The user denied this action. Do not retry it; continue another way or explain what you need.' };
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

export type BridgeHandler = (req: { tool_name: string; input: Record<string, unknown>; tool_use_id?: string; signal: AbortSignal }) => Promise<{ allow: boolean; message?: string }>;
/** An engine's ask_agent call (through Wren's MCP helper): the answer, or why there is none. */
export type AskHandler = (req: { agent: string; question: string; signal: AbortSignal }) => Promise<{ text: string; isError?: boolean }>;

/** How long an engine waits for another agent's answer (the server stops asked tasks after an hour too). */
export const ASK_WAIT_MS = 60 * 60_000;

/**
 * An engine asks another of the user's agents (Claude Code's ask_agent tool) and waits for the answer, like
 * an approval: polling the server while the CLI's call stays open. Stop (or the CLI going away) stops the
 * asked agent too. The ask's key is the question itself, so a turn run again after a crash finds the task
 * it already started; the same question asked again in one turn (`seen`) is a new ask.
 */
export async function askThroughWren(
  run: EngineRun,
  writer: TimelineWriter,
  req: { agent: string; question: string; signal: AbortSignal },
  seen: Map<string, number>,
  opts: { pollMs?: number; waitMs?: number } = {},
): Promise<{ text: string; isError?: boolean }> {
  const agent = req.agent.trim();
  const question = req.question.trim().slice(0, 8000);
  if (!agent || !question) return { text: 'Say which agent to ask and what to ask it.', isError: true };
  const hash = createHash('sha256').update(`${run.runId}\n${agent.toLowerCase()}\n${question}`).digest('hex').slice(0, 40);
  const n = (seen.get(hash) ?? 0) + 1;
  seen.set(hash, n);
  const key = n === 1 ? `engine:${hash}` : `engine:${hash}:${n}`;
  const over = () => req.signal.aborted || run.signal.aborted;
  const started = await run.store.askAgent({ key, agent, question });
  if ('error' in started) return { text: started.error, isError: true };
  // The step the engine's stream showed for this call links to the asked task.
  const title = describeCall('task.ask_agent', { agent, question });
  const shown = writer.matchOpen('task.ask_agent', title, false) ?? writer.matchOpen('task.ask_agent', describeCall('task.ask_agent', { agent: started.agent, question }), false);
  const step = shown ? writer.tools.get(shown) : undefined;
  if (step) await writer.setStep(step, 'awaiting_agent', { ask: { sessionId: started.sessionId, agent: started.agent } }).catch(() => {});
  const giveUpAt = Date.now() + (opts.waitMs ?? ASK_WAIT_MS);
  for (;;) {
    if (over()) {
      await run.store.cancelAsk(key).catch(() => {});
      // Shown as stopped: the engine may still report the call it was waiting on as failed ("Connection
      // closed" once its helper is gone), which toolEnd then leaves alone.
      if (step) await writer.setStep(step, 'cancelled', { endedAt: Date.now(), result: { output: 'Stopped while waiting for the answer.', isError: true } }).catch(() => {});
      return { text: 'Stopped: the task was stopped while waiting for the answer.', isError: true };
    }
    if (Date.now() > giveUpAt) {
      await run.store.cancelAsk(key).catch(() => {});
      return { text: `${started.agent} didn’t answer within ${Math.round((opts.waitMs ?? ASK_WAIT_MS) / 60_000)} minutes, so its task was stopped. Carry on without it.`, isError: true };
    }
    const a = await run.store.agentAnswer(key).catch(() => ({ state: 'pending' as const, agent: started.agent }));
    if (a.state === 'answered') return { text: agentAnswerText(a.agent, a.answer) };
    if (a.state === 'failed') return { text: a.error, isError: true };
    await new Promise<void>((r) => {
      const t = setTimeout(r, opts.pollMs ?? 2000);
      const stop = () => (clearTimeout(t), r());
      req.signal.addEventListener('abort', stop, { once: true });
      run.signal.addEventListener('abort', stop, { once: true });
    });
  }
}

/** Localhost endpoint that engine permission hooks call back into (per-run bearer token). */
/** Requests being decided at once: an engine runs several tools in parallel, background sub-agents too. */
const MAX_OPEN_PROMPTS = 32;
const MAX_PROMPT_BYTES = 512 * 1024;

/**
 * The local endpoint an engine's permission prompts call (W-121, W-129). A request holds its place until
 * Wren has decided it, not just while its connection is open; if the asker goes away, the handler's
 * signal fires (the approval is withdrawn), and closing the bridge does the same for everything open.
 */
/** How long a request may take to arrive (not to be decided); `checkMs` is how often Node checks (its default is 30 s). */
const ARRIVAL = { requestMs: 15_000, headersMs: 10_000, checkMs: 5_000 };

export async function startApprovalBridge(handler: BridgeHandler, arrival = ARRIVAL, onAsk?: AskHandler): Promise<{ url: string; token: string; close: () => void }> {
  const token = randomBytes(24).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  // Every admitted request, from admission (still sending its body) until its decision ends (W-135).
  const active = new Set<AbortController>();
  let admitted = 0;
  let closing = false;
  const server = createServer({ connectionsCheckingInterval: arrival.checkMs }, (req, res) => {
    if (closing) {
      res.statusCode = 503;
      res.end(JSON.stringify({ behavior: 'deny', message: 'The task has ended.' }));
      return;
    }
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (req.method !== 'POST' || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    if (admitted >= MAX_OPEN_PROMPTS) {
      res.statusCode = 429;
      res.end(JSON.stringify({ behavior: 'deny', message: 'Too many permission requests at once.' }));
      return;
    }
    admitted++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        admitted--;
      }
    };
    const gone = new AbortController();
    active.add(gone);
    let started = false;
    // Called off (the asker left, or the bridge closed): a request still arriving is dropped.
    gone.signal.addEventListener('abort', () => {
      if (!started) req.destroy();
    });
    // The asker went away: before its request was complete nothing runs; after, the decision is called off.
    res.on('close', () => {
      if (!res.writableFinished) gone.abort();
      if (!started) {
        active.delete(gone);
        release();
      }
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_PROMPT_BYTES) {
        res.statusCode = 413;
        res.end(JSON.stringify({ behavior: 'deny', message: 'Permission request too large.' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded || gone.signal.aborted || closing) return;
      started = true;
      res.setHeader('content-type', 'application/json');
      try {
        const r = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (r && typeof r.ask === 'object' && r.ask) {
          // The helper's ask_agent tool: answered with the other agent's answer (or why there is none).
          const out = onAsk && !gone.signal.aborted ? await onAsk({ agent: String(r.ask.agent ?? ''), question: String(r.ask.question ?? ''), signal: gone.signal }) : { text: 'Asking other agents isn’t available here.', isError: true };
          res.end(JSON.stringify(out));
          return;
        }
        const d = await handler({ tool_name: String(r.tool_name ?? 'unknown'), input: (r.input ?? {}) as Record<string, unknown>, tool_use_id: r.tool_use_id, signal: gone.signal });
        res.end(JSON.stringify(d.allow && !gone.signal.aborted ? { behavior: 'allow', updatedInput: r.input } : { behavior: 'deny', message: d.message ?? 'Denied.' }));
      } catch (e) {
        res.end(JSON.stringify({ behavior: 'deny', message: `Wren could not evaluate this action: ${(e as Error).message}` }));
      } finally {
        active.delete(gone);
        release();
      }
    });
  });
  // A request must arrive in full quickly (it's a few KB from a local helper); its decision may then take as
  // long as the user needs: these limits cover receiving the request only (W-135).
  server.requestTimeout = arrival.requestMs;
  server.headersTimeout = arrival.headersMs;
  server.timeout = 0;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/approve`,
    token,
    close: () => {
      closing = true;
      for (const c of active) c.abort();
      server.close();
    },
  };
}

export type { LoopOutcome };
