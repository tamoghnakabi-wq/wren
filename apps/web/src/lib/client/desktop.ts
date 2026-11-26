'use client';

import { useSyncExternalStore } from 'react';

// Bridge exposed by the Wren desktop app's preload script. Everything here is
// optional: the same web app runs in browsers, where `window.wren` is absent.

export interface DesktopPolicy {
  folders: string[];
  shell: boolean;
  browser: boolean;
  screen: boolean;
  remoteApprovals: boolean;
  localModelUrl: string;
  /** Desktop 0.1.49 and later. */
  keepAwake?: boolean;
}

export interface DesktopStatus {
  version: string;
  platform: 'darwin' | 'win32' | 'linux';
  linked: boolean;
  lastError?: string;
  deviceId?: string;
  deviceName?: string;
  account?: { email?: string };
  connected: boolean;
  runningRuns: number;
  chatgpt: { signedIn: boolean; email?: string; planUsage?: boolean; error?: string };
  engines: { claudeCode: { installed: boolean; version?: string; loggedIn?: boolean }; grokBuild: { installed: boolean; version?: string; loggedIn?: boolean } };
  local: { baseUrl: string; reachable: boolean; models: { id: string; name: string }[] };
  /** `received`, `total` and `retryAt` come from desktop 0.1.9 and later. */
  update?: { available: boolean; version?: string; downloading?: boolean; received?: number; total?: number; ready?: boolean; error?: string; retryAt?: number };
}

/** Another AI app whose usage logs the desktop reads (Usage → This Mac). */
export type LocalApp = 'claude-code' | 'codex' | 'grok-build' | 'antigravity' | 'opencode';

/** One day × app × model × speed × prompt size, summed by the desktop app (main/local-usage). */
export interface LocalUsageRow {
  day: string;
  app: LocalApp;
  model: string;
  speed: 'standard' | 'fast' | 'ultrafast';
  /** The largest prompt size (tokens) its requests were over, for long-prompt prices; 0 for none. */
  tier: number;
  requests: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
  /** The cost the app itself recorded, or null when it didn't. */
  costUsd: number | null;
}

/** What the desktop read from the other AI apps' logs on this computer (desktop 0.1.53+). */
export interface LocalUsageReport {
  version: 1;
  generatedAt: number;
  /** This computer's calendar days, oldest first; the last is today (90 of them). */
  days: string[];
  apps: { id: LocalApp; found: boolean; files: number; unreadable: number }[];
  rows: LocalUsageRow[];
  /** A session's app and the last day it used a model. */
  sessions: [LocalApp, string][];
  seconds: number;
}

export interface WrenDesktop {
  /** 'hidden' when the window has no title bar (macOS, desktop 0.1.52+); lib/prefs.ts marks the page from it. */
  titleBar?: 'hidden';
  status(): Promise<DesktopStatus>;
  link(): Promise<{ userCode: string; pairId: string }>;
  unlink(): Promise<void>;
  getPolicy(): Promise<DesktopPolicy>;
  setPolicy(p: Partial<DesktopPolicy>): Promise<DesktopPolicy>;
  addFolder(): Promise<DesktopPolicy>;
  chatgptSignIn(): Promise<{ ok: boolean; error?: string; email?: string; planUsage?: boolean }>;
  chatgptSignOut(): Promise<void>;
  openEngineLogin(engine: 'claude-code' | 'grok-build'): Promise<void>;
  checkUpdate(): Promise<DesktopStatus['update']>;
  installUpdate(): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Show this computer's native approval prompt for one of its runs (remote approvals off). Added in 0.1.3. */
  decideApproval?(runId: string, approvalId: string): Promise<{ decided?: boolean; error?: string }>;
  onStatus(cb: (s: DesktopStatus) => void): () => void;
  /** Usage of the other AI apps on this computer, read from their logs (0.1.53+). Never sent to Wren. */
  localUsage?(opts?: { refresh?: boolean }): Promise<LocalUsageReport>;
}

declare global {
  interface Window {
    wren?: WrenDesktop;
  }
}

export const desktop = (): WrenDesktop | undefined => (typeof window !== 'undefined' ? window.wren : undefined);

/** The desktop bridge, available only after mount (keeps server and client renders identical). */
export function useDesktop(): WrenDesktop | undefined {
  return useSyncExternalStore(noSubscribe, () => window.wren, () => undefined);
}
function noSubscribe() {
  return () => {};
}
