// How much of each AI app's plan limits is used, for Usage → This Mac (window.wren.planLimits). Each app says so
// itself, with its own sign-in (Wren never reads any app's credentials):
// - Claude Code: its `get_usage` control request in stream-json mode (what /usage shows).
// - Codex: `codex app-server`'s `account/rateLimits/read` (what its own status shows), the program checked as an
//   engine's is (sandbox.ts checkCodexProgram).
// - Grok Build: `grok usage --json`, which answers only while Grok's background service runs (its "daemon
//   route"); otherwise Wren says so. Its JSON isn't documented, so it is read by common field names.
// No prompt is sent to any of them, so nothing reaches a model and nothing counts against the limits. Only the
// windows, the plan's name and banked resets are kept; nothing is sent to Wren's server.

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { claudeSupportsRestricted, cliHasFlag, engineEnv, findClis } from '../engines/common';
import { engineProgram } from '../engines/program';
import { cliOutput } from './capabilities';
import { dataDir } from './config';
import { allowedRoots } from './paths';
import { checkCodexProgram } from './sandbox';
import { agentEnv, toolEnv } from './shellenv';

export interface LimitWindow {
  /** `session`, `weekly`, or `weekly:<model>` for a model's own weekly limit. */
  id: string;
  label: string;
  /** How long the window is, to judge the pace; null when unknown. */
  minutes: number | null;
  /** Share of the limit used, 0–100. */
  used: number;
  /** When the window resets (ms since 1970), or null. */
  resetsAt: number | null;
}

export type LimitsApp = 'claude-code' | 'codex' | 'grok-build';

export interface AppLimits {
  app: LimitsApp;
  /**
   * `ok`: windows read. `none`: this sign-in has no plan limits (an API key, Bedrock or Vertex, a team's own).
   * `missing`: not installed. `untrusted`: Wren won't run the copy it found. `old`: too old to say.
   * `unavailable`: it can't say right now (Grok without its background service). `failed`: no answer.
   */
  state: 'ok' | 'none' | 'missing' | 'untrusted' | 'old' | 'unavailable' | 'failed';
  plan?: string;
  windows: LimitWindow[];
  /** Full resets the plan holds to use later (Codex's banked reset credits). */
  resetsBanked?: number;
  /** Why there are no windows, in the app's own words (clipped), when it gave one. */
  note?: string;
}

export interface PlanLimitsReport {
  version: 1;
  generatedAt: number;
  apps: AppLimits[];
}

const REQUEST_ID = 'wren-limits';
const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;

/** The windows Claude Code names, in the order shown. */
const CLAUDE_WINDOWS: [key: string, id: string, label: string, minutes: number][] = [
  ['five_hour', 'session', '5-hour limit', SESSION_MINS],
  ['seven_day', 'weekly', 'Weekly limit', WEEK_MINS],
  ['seven_day_opus', 'weekly:opus', 'Opus weekly limit', WEEK_MINS],
  ['seven_day_sonnet', 'weekly:sonnet', 'Sonnet weekly limit', WEEK_MINS],
];

const PLANS: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', plus: 'Plus', go: 'Go', free: 'Free', business: 'Business', edu: 'Edu' };

/** A plan's name as the user knows it, from the app's own word for it (only a word that looks like one). */
function planName(raw: unknown): string | undefined {
  const type = typeof raw === 'string' ? raw.toLowerCase() : '';
  return PLANS[type] ?? (/^[a-z][a-z0-9_]{0,23}$/.test(type) ? type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : undefined);
}

/** A window's name from its length: "5-hour limit", "Weekly limit", "Monthly limit", "3-day limit"… */
export function windowLabel(minutes: number | null): string {
  if (!minutes) return 'Limit';
  if (minutes === WEEK_MINS) return 'Weekly limit';
  if (minutes >= 28 * 1440 && minutes <= 31 * 1440) return 'Monthly limit';
  if (minutes === 1440) return 'Daily limit';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
  return `${Math.round(minutes / 60)}-hour limit`;
}

/** A time as ms since 1970, from seconds, milliseconds or an ISO string; null when it isn't one. */
function timeOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

const clip = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

function window(id: string, label: string, minutes: number, raw: unknown): LimitWindow | null {
  const w = raw as { utilization?: unknown; resets_at?: unknown } | null | undefined;
  if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
  const at = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
  return { id, label, minutes, used: Math.max(0, Math.min(100, w.utilization)), resetsAt: Number.isFinite(at) ? at : null };
}

/** Claude Code's limits from what it printed in answer to `get_usage` (only the fields named here are read). */
export function parseClaudeLimits(out: string): AppLimits {
  const base = { app: 'claude-code' as const, windows: [] as LimitWindow[] };
  for (const line of out.split('\n')) {
    if (!line.includes('"control_response"') || !line.includes(REQUEST_ID)) continue;
    let m: { response?: { subtype?: unknown; request_id?: unknown; error?: unknown; response?: Record<string, unknown> } };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.response?.request_id !== REQUEST_ID) continue;
    if (m.response.subtype !== 'success' || !m.response.response) {
      const error = typeof m.response.error === 'string' ? clip(m.response.error, 200) : '';
      // A version without the request says so ("get_usage is not supported…").
      return { ...base, state: /not supported|unknown|unsupported/i.test(error) ? 'old' : 'failed', ...(error ? { note: error } : {}) };
    }
    const r = m.response.response;
    const plan = planName(r.subscription_type);
    const withPlan = { ...base, ...(plan ? { plan } : {}) };
    const limits = r.rate_limits as Record<string, unknown> | null | undefined;
    if (r.rate_limits_available === false || !limits || typeof limits !== 'object') return { ...withPlan, state: 'none' };
    const windows: LimitWindow[] = [];
    for (const [key, id, label, minutes] of CLAUDE_WINDOWS) {
      const w = window(id, label, minutes, limits[key]);
      if (w) windows.push(w);
    }
    // A model's own weekly limit (e.g. Fable), labelled by the server.
    if (Array.isArray(limits.model_scoped)) {
      for (const x of limits.model_scoped.slice(0, 8) as { display_name?: unknown }[]) {
        const name = typeof x?.display_name === 'string' ? clip(x.display_name, 40) : '';
        if (!name) continue;
        const id = `weekly:${name.toLowerCase()}`;
        if (windows.some((w) => w.id === id)) continue;
        const w = window(id, `${name} weekly limit`, WEEK_MINS, x);
        if (w) windows.push(w);
      }
    }
    return { ...withPlan, state: windows.length ? 'ok' : 'none', windows };
  }
  return { ...base, state: 'failed' };
}

async function claudeLimits(folders: string[]): Promise<AppLimits> {
  const base = { app: 'claude-code' as const, windows: [] };
  // Only the copy a run would start, checked first (W-183): one Wren won't start is never run.
  const found = await engineProgram('claude-code', folders);
  if (!found) return { ...base, state: 'missing' };
  if ('untrusted' in found) return { ...base, state: 'untrusted' };
  // As for the model list: restricted, with no tools, MCP servers or saved session, and no prompt.
  if (!claudeSupportsRestricted(found.program) || !cliHasFlag('claude-code', found.program, '--no-session-persistence')) return { ...base, state: 'old' };
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--restricted', '--no-session-persistence', '--strict-mcp-config', '--tools', ''];
  const input = JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'get_usage' } }) + '\n';
  const answered = (o: string) => o.split('\n').slice(0, -1).some((l) => l.includes('"control_response"') && l.includes(REQUEST_ID));
  const out = await cliOutput('claude-code', found.program, args, { input, done: answered, timeoutMs: 20_000 });
  return parseClaudeLimits(out);
}

/**
 * Codex's limits from its app server's answer to `account/rateLimits/read`: the main snapshot's windows
 * (`primary`, `secondary`), any other limit's (named by Codex), the plan and banked resets.
 */
export function parseCodexLimits(res: unknown): AppLimits {
  const base = { app: 'codex' as const, windows: [] as LimitWindow[] };
  const r = (res && typeof res === 'object' ? res : {}) as { rateLimits?: unknown; rateLimitsByLimitId?: unknown; rateLimitResetCredits?: { availableCount?: unknown } };
  type Snap = { limitId?: unknown; limitName?: unknown; primary?: unknown; secondary?: unknown; planType?: unknown };
  const main = (r.rateLimits && typeof r.rateLimits === 'object' ? r.rateLimits : null) as Snap | null;
  const others = (r.rateLimitsByLimitId && typeof r.rateLimitsByLimitId === 'object' ? Object.values(r.rateLimitsByLimitId) : []) as Snap[];
  const banked = typeof r.rateLimitResetCredits?.availableCount === 'number' && r.rateLimitResetCredits.availableCount > 0 ? Math.min(99, Math.floor(r.rateLimitResetCredits.availableCount)) : undefined;
  const plan = planName(main?.planType ?? others[0]?.planType);
  const windows: LimitWindow[] = [];
  const add = (snap: Snap, prefix: string) => {
    for (const slot of ['primary', 'secondary'] as const) {
      const w = snap[slot] as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null | undefined;
      if (!w || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) continue;
      const minutes = typeof w.windowDurationMins === 'number' && w.windowDurationMins > 0 ? Math.round(w.windowDurationMins) : null;
      const id = `${prefix ? `${prefix}:` : ''}${slot}`;
      if (windows.some((x) => x.id === id)) continue;
      const label = windowLabel(minutes);
      windows.push({ id, label: prefix ? `${prefix} ${label.replace(/^./, (c) => c.toLowerCase())}` : label, minutes, used: Math.max(0, Math.min(100, w.usedPercent)), resetsAt: timeOf(w.resetsAt) });
    }
  };
  if (main) add(main, '');
  const mainId = typeof main?.limitId === 'string' ? main.limitId : 'codex';
  for (const o of others.slice(0, 6)) {
    if (!o || typeof o !== 'object' || o.limitId === mainId) continue;
    const name = typeof o.limitName === 'string' && o.limitName.trim() ? clip(o.limitName, 40) : typeof o.limitId === 'string' ? clip(o.limitId, 40) : '';
    if (name) add(o, name);
  }
  return { ...base, ...(plan ? { plan } : {}), ...(banked ? { resetsBanked: banked } : {}), state: windows.length ? 'ok' : 'none', windows };
}

/** Names for Grok Build's windows by their kind, with their length. */
const GROK_KINDS: Record<string, { label: string; minutes: number }> = {
  session: { label: '5-hour limit', minutes: SESSION_MINS },
  five_hour: { label: '5-hour limit', minutes: SESSION_MINS },
  daily: { label: 'Daily limit', minutes: 1440 },
  weekly: { label: 'Weekly limit', minutes: WEEK_MINS },
  seven_day: { label: 'Weekly limit', minutes: WEEK_MINS },
  monthly: { label: 'Monthly limit', minutes: 30 * 1440 },
  billing_period: { label: 'Billing period', minutes: 30 * 1440 },
};

/**
 * Grok Build's limits from `grok usage --json` (its output and how it ended). Its JSON isn't documented, so windows
 * are found by common field names: a share used (or left) and a reset time, named by a label or kind.
 */
export function parseGrokUsage(r: { code: number | null; stdout: string; stderr: string }): AppLimits {
  const base = { app: 'grok-build' as const, windows: [] as LimitWindow[] };
  const said = `${r.stdout}\n${r.stderr}`;
  if (/managed by your team/i.test(said)) return { ...base, state: 'none', note: 'Your team manages Grok Build’s usage limits.' };
  if (/can['’]t show your plan['’]s usage here|background service/i.test(said)) return { ...base, state: 'unavailable' };
  if (/not signed in|log ?in first|grok login/i.test(r.stderr)) return { ...base, state: 'failed', note: 'Grok Build isn’t signed in.' };
  let data: unknown;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    return { ...base, state: 'failed', ...(r.stderr.trim() ? { note: clip(r.stderr, 200) } : {}) };
  }
  const windows: LimitWindow[] = [];
  let plan: string | undefined;
  const visit = (v: unknown, key: string, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 5 || windows.length >= 8) return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 20)) visit(x, key, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    plan ??= planName(o.plan ?? o.planType ?? o.plan_type ?? o.tier);
    const num = (re: RegExp) => {
      const k = Object.keys(o).find((x) => re.test(x) && typeof o[x] === 'number' && Number.isFinite(o[x] as number));
      return k === undefined ? undefined : { k, v: o[k] as number };
    };
    const usedField = num(/^(used_?percent(age)?|percent_?used|usage_?percent(age)?|utilization)$/i);
    const leftField = num(/^(remaining_?percent(age)?|percent_?remaining|left_?percent)$/i);
    if (usedField || leftField) {
      const raw = usedField ? usedField.v : 100 - leftField!.v;
      // A utilization of 0.42 is a share, not 0.42%.
      const used = usedField && /utilization/i.test(usedField.k) && usedField.v <= 1 ? usedField.v * 100 : raw;
      const kindRaw = [o.kind, o.window, o.period, o.type, key].find((x) => typeof x === 'string' && x) as string | undefined;
      const kind = kindRaw ? GROK_KINDS[kindRaw.toLowerCase()] : undefined;
      const mins = [o.window_minutes, o.windowMinutes, o.windowDurationMins, o.window_duration_mins, o.duration_minutes].find((x) => typeof x === 'number' && x > 0) as number | undefined;
      const minutes = mins ? Math.round(mins) : (kind?.minutes ?? null);
      const label = typeof o.label === 'string' && o.label.trim() ? clip(o.label, 40) : typeof o.name === 'string' && o.name.trim() ? clip(o.name, 40) : (kind?.label ?? windowLabel(minutes));
      const resetKey = Object.keys(o).find((x) => /^(resets?_?at|reset_?time|resets?|next_?reset(_?at)?|period_?end(s_?at)?)$/i.test(x));
      windows.push({ id: `w${windows.length}`, label, minutes, used: Math.max(0, Math.min(100, used)), resetsAt: resetKey ? timeOf(o[resetKey]) : null });
      return;
    }
    for (const [k, x] of Object.entries(o)) visit(x, k, depth + 1);
  };
  visit(data, '', 0);
  if (!windows.length) return { ...base, ...(plan ? { plan } : {}), state: 'failed', note: 'Grok Build answered in a form Wren doesn’t read yet.' };
  return { ...base, ...(plan ? { plan } : {}), state: 'ok', windows };
}

/** The Codex program Wren may run (as an engine's is checked), or why not, or null when none is installed. */
async function codexProgram(folders: string[]): Promise<{ program: string } | { untrusted: string } | null> {
  await toolEnv();
  let first: string | undefined;
  for (const cli of findClis('codex')) {
    const r = checkCodexProgram(cli, allowedRoots(folders), dataDir());
    if ('program' in r) return r;
    first ??= r.why;
  }
  return first === undefined ? null : { untrusted: first };
}

/** Codex's environment: its own home and the network settings, nothing of Wren's. */
function codexEnv(): NodeJS.ProcessEnv {
  const env = agentEnv(process.env, {});
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && /^(CODEX_HOME|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|ALL_PROXY|all_proxy|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(k)) env[k] = v;
  return env;
}

/** Asks `codex app-server` for `account/rateLimits/read` (JSON-RPC over its standard input and output). */
function codexRateLimits(program: string, timeoutMs = 20_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, ['app-server'], { cwd: tmpdir(), env: codexEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let done = false;
    const end = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      fn();
    };
    const timer = setTimeout(() => end(() => reject(new Error('Codex didn’t answer in time.'))), timeoutMs);
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n');
    child.stdin.on('error', () => {});
    child.on('error', (e) => end(() => reject(e)));
    child.on('close', () => end(() => reject(new Error('Codex stopped before it answered.'))));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
      if (out.length > 1_000_000) return end(() => reject(new Error('Codex said too much.')));
      const lines = out.split('\n');
      out = lines.pop() ?? '';
      for (const line of lines) {
        let m: { id?: unknown; result?: unknown; error?: { message?: unknown } };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 0) {
          if (m.error) return end(() => reject(new Error(typeof m.error?.message === 'string' ? clip(m.error.message, 200) : 'Codex refused to start.')));
          send({ method: 'initialized' });
          send({ id: 1, method: 'account/rateLimits/read' });
        } else if (m.id === 1) {
          if (m.error) return end(() => reject(new Error(typeof m.error?.message === 'string' ? clip(m.error.message, 200) : 'Codex couldn’t read its limits.')));
          const result = m.result;
          return end(() => resolve(result));
        }
      }
    });
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'wren', title: 'Wren', version: '1' } } });
  });
}

async function codexLimits(folders: string[]): Promise<AppLimits> {
  const base = { app: 'codex' as const, windows: [] };
  const found = await codexProgram(folders);
  if (!found) return { ...base, state: 'missing' };
  if ('untrusted' in found) return { ...base, state: 'untrusted' };
  try {
    return parseCodexLimits(await codexRateLimits(found.program));
  } catch (e) {
    const msg = (e as Error).message;
    // A version without the app server, or without this request.
    return { ...base, state: /unknown|not found|unrecognized|method/i.test(msg) ? 'old' : 'failed', note: clip(msg, 200) };
  }
}

/** Runs a program (never in a shell) and gives back what it printed and how it ended. */
function capture(program: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout = (stdout + c).slice(0, 200_000)));
    child.stderr.on('data', (c: string) => (stderr = (stderr + c).slice(-4000)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function grokLimits(folders: string[]): Promise<AppLimits> {
  const base = { app: 'grok-build' as const, windows: [] };
  const found = await engineProgram('grok-build', folders);
  if (!found) return { ...base, state: 'missing' };
  if ('untrusted' in found) return { ...base, state: 'untrusted' };
  return parseGrokUsage(await capture(found.program, ['--no-auto-update', 'usage', '--json'], engineEnv('grok-build'), 15_000));
}

/** A report this recent is answered again instead of asking again. */
const FRESH_MS = 60_000;
let last: PlanLimitsReport | null = null;
let asking: Promise<PlanLimitsReport> | null = null;

/** Every app's plan limits; asked again after a minute, or at once with `refresh`. One ask at a time. */
export function planLimits(folders: string[], opts: { refresh?: boolean } = {}): Promise<PlanLimitsReport> {
  if (asking) return asking;
  if (last && !opts.refresh && Date.now() - last.generatedAt < FRESH_MS) return Promise.resolve(last);
  const failed = (app: LimitsApp) => (): AppLimits => ({ app, state: 'failed', windows: [] });
  asking = Promise.all([claudeLimits(folders).catch(failed('claude-code')), codexLimits(folders).catch(failed('codex')), grokLimits(folders).catch(failed('grok-build'))])
    .then((apps) => (last = { version: 1, generatedAt: Date.now(), apps }))
    .finally(() => {
      asking = null;
    });
  return asking;
}
