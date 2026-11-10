import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { claudeSupportsRestricted, cliHasFlag, engineEnv } from '../engines/common';
import { engineProgram } from '../engines/program';
import * as chatgpt from './chatgpt';
import type { Policy } from './config';

// What this computer can offer agents, reported to the server with each
// heartbeat (shown in Connections and used by the model picker).

export interface ModelChoice {
  id: string;
  name: string;
  description?: string;
}

interface EngineCaps {
  installed: boolean;
  version?: string;
  untrusted?: string;
  /** The models this CLI offers the signed-in account, as the CLI itself lists them. */
  models?: ModelChoice[];
}

export interface Capabilities {
  chatgpt: { signedIn: boolean; email?: string; planUsage?: boolean; models?: { id: string; name: string }[] };
  claudeCode: EngineCaps;
  grokBuild: EngineCaps;
  local: { baseUrl: string; reachable: boolean; models: { id: string; name: string }[] };
  browser: { available: boolean; name?: string };
}

type EngineName = 'claude-code' | 'grok-build';

const versionCache = new Map<string, { at: number; v?: string }>();
/**
 * Whether the CLI is installed, its version and its models. Asking runs it, outside any sandbox, so only
 * the program a run would start, checked first (W-183, W-187): one Wren won't start is reported, never run.
 */
async function engineCaps(engine: EngineName, folders: string[]): Promise<EngineCaps> {
  const found = await engineProgram(engine, folders);
  if (!found) return { installed: false };
  if ('untrusted' in found) return { installed: true, untrusted: found.untrusted };
  const cached = versionCache.get(found.program);
  let version = cached?.v;
  if (!cached || Date.now() - cached.at >= 10 * 60_000) {
    const claude = engine === 'claude-code';
    const r = spawnSync(found.program, claude ? ['--version'] : ['version'], { encoding: 'utf8', timeout: 8000, env: engineEnv(engine) });
    version = (r.stdout || '').trim().split(/\s+/)[claude ? 0 : 1] || 'installed';
    versionCache.set(found.program, { at: Date.now(), v: version });
  }
  const models = await engineModels(engine, found.program, version);
  return { installed: true, version, ...(models.length ? { models } : {}) };
}

/** A model id that is safe to hand back to the CLI as one argument (never read as a flag). */
const MODEL_ID = /^[A-Za-z0-9][\w.:/[\]-]{0,99}$/;
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/**
 * Claude Code's models, from the answer to its `initialize` control request in stream-json mode (what the
 * Agent SDK's supportedModels() reads). Only the model list is kept: the same answer names the account.
 */
export function parseClaudeModels(out: string): ModelChoice[] {
  for (const line of out.split('\n')) {
    if (!line.includes('"control_response"')) continue;
    try {
      const m = JSON.parse(line) as { response?: { response?: { models?: unknown }; models?: unknown } };
      const list = m.response?.response?.models ?? m.response?.models;
      if (!Array.isArray(list)) return [];
      const seen = new Set<string>();
      const models: ModelChoice[] = [];
      for (const x of list as Record<string, unknown>[]) {
        const id = typeof x?.value === 'string' ? x.value : '';
        if (!MODEL_ID.test(id) || seen.has(id)) continue;
        seen.add(id);
        const description = text(x.description, 160);
        models.push({ id, name: text(x.displayName, 80) ?? id, ...(description ? { description } : {}) });
      }
      return models.slice(0, 40);
    } catch {
      return [];
    }
  }
  return [];
}

/** Grok Build's models, from `grok models` ("Available models:" then one id per line, the default marked). */
export function parseGrokModels(out: string): ModelChoice[] {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => /^\s*available models:/i.test(l));
  if (start < 0) return [];
  const models: ModelChoice[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) {
      if (models.length) break;
      continue;
    }
    const m = /^\s*\*?\s*(\S+)\s*(\(default\))?\s*$/i.exec(line);
    if (!m || !MODEL_ID.test(m[1])) break;
    if (!models.some((x) => x.id === m[1])) models.push({ id: m[1], name: m[1], ...(m[2] ? { description: 'Grok Build’s default' } : {}) });
  }
  return models.slice(0, 40);
}

/** Runs the CLI (never in a shell) and gives back what it printed, stopping it once `done` says so or time is up. */
function cliOutput(engine: EngineName, program: string, args: string[], opts: { input?: string; done?: (out: string) => boolean; timeoutMs: number }): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(program, args, { cwd: tmpdir(), env: engineEnv(engine), stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      resolve(out);
    };
    timer = setTimeout(finish, opts.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
      if (out.length > 1_000_000 || opts.done?.(out)) finish();
    });
    child.on('error', finish);
    child.on('close', finish);
    child.stdin.on('error', () => {});
    if (opts.input) child.stdin.write(opts.input);
    // Claude Code answers on an open input; Grok needs none.
    if (!opts.done) child.stdin.end();
  });
}

async function listModels(engine: EngineName, program: string): Promise<ModelChoice[]> {
  if (engine === 'claude-code') {
    // Restricted, with no tools, MCP servers or saved session: only the question below is asked, and no prompt
    // is sent, so nothing reaches the model. A version without these flags is too old for Wren anyway.
    if (!claudeSupportsRestricted(program) || !cliHasFlag('claude-code', program, '--no-session-persistence')) return [];
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--restricted', '--no-session-persistence', '--strict-mcp-config', '--tools', ''];
    const input = JSON.stringify({ type: 'control_request', request_id: 'wren-models', request: { subtype: 'initialize' } }) + '\n';
    const out = await cliOutput(engine, program, args, { input, done: (o) => /"control_response"[^\n]*\n/.test(o), timeoutMs: 15_000 });
    return parseClaudeModels(out);
  }
  return parseGrokModels(await cliOutput(engine, program, ['--no-auto-update', 'models'], { timeoutMs: 15_000 }));
}

const modelCache = new Map<string, { at: number; version?: string; list: ModelChoice[] }>();
const asking = new Map<string, Promise<ModelChoice[]>>();
/**
 * The CLI's model list, asked again every 30 minutes, when the CLI is updated, or after 5 minutes when it
 * listed none (not signed in yet). The heartbeat waits a few seconds at most; a slower answer comes next time.
 */
async function engineModels(engine: EngineName, program: string, version: string | undefined): Promise<ModelChoice[]> {
  const cached = modelCache.get(program);
  const fresh = cached && cached.version === version && Date.now() - cached.at < (cached.list.length ? 30 : 5) * 60_000;
  if (fresh) return cached.list;
  let pending = asking.get(program);
  if (!pending) {
    pending = listModels(engine, program)
      .catch(() => [] as ModelChoice[])
      .then((list) => {
        modelCache.set(program, { at: Date.now(), version, list });
        asking.delete(program);
        return list;
      });
    asking.set(program, pending);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<null>((r) => (timer = setTimeout(() => r(null), 10_000)));
  try {
    return (await Promise.race([pending, wait])) ?? cached?.list ?? [];
  } finally {
    clearTimeout(timer);
  }
}

function browserName(): string | undefined {
  const paths: [string, string][] =
    process.platform === 'darwin'
      ? [['/Applications/Google Chrome.app', 'Google Chrome'], ['/Applications/Microsoft Edge.app', 'Microsoft Edge']]
      : process.platform === 'win32'
        ? [[`${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`, 'Microsoft Edge'], [`${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`, 'Google Chrome'], [`${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`, 'Google Chrome']]
        : [['/usr/bin/google-chrome', 'Google Chrome'], ['/usr/bin/chromium', 'Chromium']];
  return paths.find(([p]) => existsSync(p))?.[1];
}

let chatgptModels: { at: number; list: { id: string; name: string }[] } = { at: 0, list: [] };

export async function detect(policy: Policy): Promise<Capabilities> {
  const local: Capabilities['local'] = { baseUrl: policy.localModelUrl, reachable: false, models: [] };
  try {
    const res = await fetch(`${policy.localModelUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const j = (await res.json()) as { data?: { id: string }[] };
      local.reachable = true;
      local.models = (j.data ?? []).filter((m) => !/embed/i.test(m.id)).map((m) => ({ id: m.id, name: m.id }));
    }
  } catch {
    /* not running */
  }
  const st = chatgpt.status();
  if (st.signedIn && st.planUsage && Date.now() - chatgptModels.at > 30 * 60_000) {
    chatgptModels = { at: Date.now(), list: await chatgpt.models().catch(() => chatgptModels.list) };
  }
  const browser = browserName();
  return {
    chatgpt: { ...st, models: st.signedIn ? chatgptModels.list : [] },
    claudeCode: await engineCaps('claude-code', policy.folders),
    grokBuild: await engineCaps('grok-build', policy.folders),
    local,
    browser: { available: !!browser, name: browser },
  };
}
