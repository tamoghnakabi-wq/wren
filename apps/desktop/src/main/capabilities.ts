import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { findCli, engineEnv } from '../engines/common';
import * as chatgpt from './chatgpt';
import type { Policy } from './config';

// What this computer can offer agents, reported to the server with each
// heartbeat (shown in Connections and used by the model picker).

export interface Capabilities {
  chatgpt: { signedIn: boolean; email?: string; planUsage?: boolean; models?: { id: string; name: string }[] };
  claudeCode: { installed: boolean; version?: string };
  grokBuild: { installed: boolean; version?: string };
  local: { baseUrl: string; reachable: boolean; models: { id: string; name: string }[] };
  browser: { available: boolean; name?: string };
}

const versionCache = new Map<string, { at: number; v?: string }>();
function cliVersion(name: 'claude' | 'grok'): { installed: boolean; version?: string } {
  const cached = versionCache.get(name);
  if (cached && Date.now() - cached.at < 10 * 60_000) return { installed: !!cached.v, version: cached.v };
  const cli = findCli(name);
  let v: string | undefined;
  if (cli) {
    const r = spawnSync(cli, name === 'claude' ? ['--version'] : ['version'], { encoding: 'utf8', timeout: 8000, env: engineEnv(name === 'claude' ? 'claude-code' : 'grok-build') });
    v = (r.stdout || '').trim().split(/\s+/)[name === 'claude' ? 0 : 1] || 'installed';
  }
  versionCache.set(name, { at: Date.now(), v });
  return { installed: !!v, version: v };
}

function browserName(): string | undefined {
  const paths: [string, string][] =
    process.platform === 'darwin'
      ? [['/Applications/Google Chrome.app', 'Google Chrome'], ['/Applications/Microsoft Edge.app', 'Microsoft Edge'], ['/Applications/Chromium.app', 'Chromium']]
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
    claudeCode: cliVersion('claude'),
    grokBuild: cliVersion('grok'),
    local,
    browser: { available: !!browser, name: browser },
  };
}
