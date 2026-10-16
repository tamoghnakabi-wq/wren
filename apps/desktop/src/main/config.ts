import { app, safeStorage } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

/** `durable`: on disk when this returns (the file before the rename, then its folder), for records a crash mustn't undo. */
function writeAtomic(path: string, data: string | Buffer, durable = false) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    if (durable) {
      const fd = openSync(tmp, 'w', 0o600);
      try {
        writeFileSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else {
      writeFileSync(tmp, data, { mode: 0o600 });
    }
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true }); // a copy of a secret mustn't stay behind
    } catch {
      /* nothing more to do */
    }
    throw e;
  }
  if (durable) syncFolder(dirname(path));
}

/** Makes renames and deletions in `dir` durable. Not every system can open a folder (Windows can't), so best effort. */
function syncFolder(dir: string) {
  try {
    const fd = openSync(dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* the file's own contents are synced */
  }
}

export function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file(name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(name: string, value: unknown, opts: { durable?: boolean } = {}) {
  writeAtomic(file(name), JSON.stringify(value, null, 2), opts.durable);
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

/**
 * Remove a secret for good: emptied, or failing that deleted, or as a last resort, when its folder can't be
 * changed but the file can, emptied where it is; each way synced to disk. True only once nothing readable is
 * left, so a caller can say when it couldn't (W-185).
 */
export function clearSecret(name: string): boolean {
  const p = file(name);
  try {
    writeAtomic(p, '', true);
  } catch {
    try {
      rmSync(p, { force: true });
      syncFolder(dirname(p));
    } catch {
      /* checked below */
    }
  }
  if (!nothingLeft(p)) emptyInPlace(p);
  return nothingLeft(p);
}

/** Missing or empty. A file that can't be read (or a folder that can't be searched) counts as still there. */
function nothingLeft(p: string): boolean {
  try {
    return readFileSync(p).length === 0;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Empties `p` in place, only if it is still the regular file just looked at: no link followed, nothing swapped in. */
function emptyInPlace(p: string) {
  try {
    const seen = lstatSync(p);
    if (!seen.isFile()) return;
    // O_NONBLOCK: a FIFO swapped in fails instead of blocking. Windows has neither flag (0); the identity check still holds.
    const fd = openSync(p, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const now = fstatSync(fd);
      if (!now.isFile() || now.dev !== seen.dev || now.ino !== seen.ino) return;
      ftruncateSync(fd, 0);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* checked by the caller */
  }
}

/** sha256 (hex) of a stored secret's bytes, which tells one stored sign-in from another; null when none is stored. Throws if it can't be read. */
export function secretDigest(name: string): string | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file(name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return bytes.length ? createHash('sha256').update(bytes).digest('hex') : null;
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

/** Permissions the page may turn off, but only the user, in a native prompt, may turn on (W-142). */
export const GRANTS = [
  ['shell', 'Run terminal commands in the folders you allowed'],
  ['browser', 'Use a separate browser window on this computer'],
  ['screen', 'Ask for screenshots of your screen'],
  ['remoteApprovals', 'Act on approvals given on your phone or the web'],
  ['launchAtLogin', 'Start when you log in to this computer'],
] as const satisfies readonly (readonly [keyof Policy, string])[];

/**
 * The policy with a change the page asked for. Asking isn't enough to turn a permission on, since anything
 * running in the page could ask (W-142): `confirm` asks the user first, in a native prompt. Turning one
 * off needs nothing. Folders are added only through the native picker; the model server must be local.
 */
export async function changedPolicy(patch: Partial<Policy>, confirm: (what: string[]) => Promise<boolean>): Promise<{ before: Policy; next: Policy }> {
  const asked = GRANTS.filter(([k]) => patch[k] === true && !loadPolicy()[k]);
  const allowed = asked.length > 0 && (await confirm(asked.map(([, what]) => what)));
  const before = loadPolicy(); // as it is now, after the prompt
  const next: Policy = { ...before, ...patch };
  for (const [k] of GRANTS) next[k] = next[k] === true && (before[k] || (allowed && asked.some(([a]) => a === k)));
  next.folders = (Array.isArray(next.folders) ? next.folders : before.folders).filter((f) => before.folders.includes(f));
  if (typeof next.localModelUrl !== 'string' || !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(next.localModelUrl)) next.localModelUrl = before.localModelUrl;
  return { before, next };
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
