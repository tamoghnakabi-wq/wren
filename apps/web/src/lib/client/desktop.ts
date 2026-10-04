'use client';

// Bridge exposed by the Wren desktop app's preload script. Everything here is
// optional: the same web app runs in browsers, where `window.wren` is absent.

export interface DesktopPolicy {
  folders: string[];
  shell: boolean;
  browser: boolean;
  screen: boolean;
  remoteApprovals: boolean;
  localModelUrl: string;
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
  update?: { available: boolean; version?: string; downloading?: boolean; ready?: boolean; error?: string };
}

export interface WrenDesktop {
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
  onStatus(cb: (s: DesktopStatus) => void): () => void;
}

declare global {
  interface Window {
    wren?: WrenDesktop;
  }
}

export const desktop = (): WrenDesktop | undefined => (typeof window !== 'undefined' ? window.wren : undefined);
