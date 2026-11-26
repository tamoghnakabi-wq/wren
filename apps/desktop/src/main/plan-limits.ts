// How much of each AI app's plan limits is used, for Usage → This Mac (window.wren.planLimits). Claude Code
// says so itself: its `get_usage` control request in stream-json mode (what /usage shows) answers with the
// 5-hour and weekly windows, as a share used and when each resets. No prompt is sent, so nothing reaches the
// model and nothing counts against the limits. Only those windows and the plan's name are kept; nothing is
// sent to Wren's server.

import { claudeSupportsRestricted, cliHasFlag } from '../engines/common';
import { engineProgram } from '../engines/program';
import { cliOutput } from './capabilities';

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

export interface AppLimits {
  app: 'claude-code';
  /**
   * `ok`: windows read. `none`: this sign-in has no plan limits (an API key, Bedrock or Vertex). `missing`: not
   * installed. `untrusted`: Wren won't run the copy it found. `old`: too old to say. `failed`: no answer.
   */
  state: 'ok' | 'none' | 'missing' | 'untrusted' | 'old' | 'failed';
  plan?: string;
  windows: LimitWindow[];
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

const PLANS: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };

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
    const type = typeof r.subscription_type === 'string' ? r.subscription_type.toLowerCase() : '';
    const plan = PLANS[type] ?? (/^[a-z][a-z0-9_]{0,23}$/.test(type) ? type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : undefined);
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

/** A report this recent is answered again instead of asking again. */
const FRESH_MS = 60_000;
let last: PlanLimitsReport | null = null;
let asking: Promise<PlanLimitsReport> | null = null;

/** Every app's plan limits; asked again after a minute, or at once with `refresh`. One ask at a time. */
export function planLimits(folders: string[], opts: { refresh?: boolean } = {}): Promise<PlanLimitsReport> {
  if (asking) return asking;
  if (last && !opts.refresh && Date.now() - last.generatedAt < FRESH_MS) return Promise.resolve(last);
  asking = claudeLimits(folders)
    .catch((): AppLimits => ({ app: 'claude-code', state: 'failed', windows: [] }))
    .then((claude) => (last = { version: 1, generatedAt: Date.now(), apps: [claude] }))
    .finally(() => {
      asking = null;
    });
  return asking;
}
