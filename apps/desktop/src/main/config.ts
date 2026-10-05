import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Local state for the desktop app. Secrets (device token, ChatGPT tokens) are
// encrypted with the OS keychain via safeStorage and written owner-only.

export const APP_URL = (process.env.WREN_URL ?? 'https://wren-agents.vercel.app').replace(/\/$/, '');
export const APP_ORIGIN = new URL(APP_URL).origin;

export function dataDir(): string {
  const d = process.env.WREN_DATA_DIR ?? app.getPath('userData');
  mkdirSync(d, { recursive: true });
  return d;
}

function file(name: string) {
  return join(dataDir(), name);
}

function writeAtomic(path: string, data: string | Buffer) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file(name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(name: string, value: unknown) {
  writeAtomic(file(name), JSON.stringify(value, null, 2));
}

export function readSecret<T>(name: string): T | null {
  const p = file(name);
  if (!existsSync(p)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const buf = readFileSync(p);
    if (!buf.length) return null;
    return JSON.parse(safeStorage.decryptString(buf)) as T;
  } catch {
    return null;
  }
}

export function writeSecret(name: string, value: unknown | null) {
  const p = file(name);
  if (value === null) {
    try {
      writeAtomic(p, '');
    } catch {
      /* ignore */
    }
    return;
  }
  // Never fall back to plaintext: without the OS keychain, secrets aren't stored at all.
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage (the system keychain) is unavailable, so Wren can’t save sign-in details on this computer.');
  writeAtomic(p, safeStorage.encryptString(JSON.stringify(value)));
}

// ------------------------------------------------------------------ policy

export interface Policy {
  folders: string[];
  shell: boolean;
  browser: boolean;
  screen: boolean;
  remoteApprovals: boolean;
  localModelUrl: string;
  launchAtLogin: boolean;
}

function defaultFolder(): string {
  const workspace = join(homedir(), 'Wren');
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

/** Read on every agent action, so changes in Settings apply to runs already under way. */
export function loadPolicy(): Policy {
  const saved = readJson<Partial<Policy>>('policy.json', {});
  return {
    shell: true,
    browser: true,
    screen: false,
    remoteApprovals: true,
    localModelUrl: 'http://127.0.0.1:1234/v1',
    launchAtLogin: false,
    ...saved,
    // Only a policy that never listed folders starts with ~/Wren; an empty list means none.
    folders: Array.isArray(saved.folders) ? saved.folders : [defaultFolder()],
  };
}

/** True when `next` takes away something `prev` allowed. */
export function permissionsReduced(prev: Policy, next: Policy): boolean {
  return (['shell', 'browser', 'screen', 'remoteApprovals'] as const).some((k) => prev[k] && !next[k]) || prev.folders.some((f) => !next.folders.includes(f));
}

export function savePolicy(p: Policy) {
  writeJson('policy.json', p);
}

// ------------------------------------------------------------------ device

export interface DeviceCredentials {
  deviceId: string;
  token: string;
  channel: string;
  account?: { email?: string; name?: string };
  supabase: { url: string; key: string };
  appUrl: string;
}

export const loadDevice = () => readSecret<DeviceCredentials>('device.bin');
export const saveDevice = (d: DeviceCredentials | null) => writeSecret('device.bin', d);

/** A stable opaque id for this installation (also the ChatGPT host id). */
export function installId(): string {
  const s = readJson<{ id?: string }>('install.json', {});
  if (s.id) return s.id;
  const id = randomUUID();
  writeJson('install.json', { id });
  return id;
}
