import { app, net } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createPublicKey, verify, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APP_URL, dataDir } from './config';
import { compareVersions } from '@wren/core';

// Self-updater. The update endpoint returns {version, url, sha256, size,
// signature}; the signature is ed25519 over a canonical string and is checked
// against the public key built into this app, so a compromised website or
// release host can't push a malicious build. macOS installs by swapping the
// app bundle after quit; Windows runs the per-user NSIS installer silently.
//
// Requests go through Chromium's network stack (`net.fetch`), the same one the
// user's browser downloaded Wren with: it follows the system proxy settings and
// trusts the OS certificate store, which Node's own fetch ignores. That matters
// on Windows, where proxies and antivirus HTTPS scanning are common.

const PUBLIC_KEY = createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgsEaViMzJQBoeqJKIwNB+dHg7kIM8veg0dYUJljLDzg=
-----END PUBLIC KEY-----`);

export interface UpdateInfo {
  version: string;
  notes?: string;
  url: string;
  sha256: string;
  size: number;
  signature: string;
}

export interface UpdateState {
  available: boolean;
  version?: string;
  downloading?: boolean;
  /** Bytes downloaded so far and the full size, while downloading. */
  received?: number;
  total?: number;
  ready?: boolean;
  error?: string;
  /** When Wren tries again after a failed check or download (ms since the epoch). */
  retryAt?: number;
  file?: string;
  /** Signed checksum/size of `file`, re-checked right before installing. */
  sha256?: string;
  size?: number;
}

/**
 * Copy the download into a fresh folder inside Wren's data folder, hashing the bytes as they are
 * written, so what gets installed is exactly what was checked. Agent commands can neither read
 * nor write Wren's data folder (every sandbox profile denies it), unlike the temp folders they
 * may use. Returns null (and removes the copy) when it doesn't match what was signed.
 */
async function verifiedCopy(file: string, sha256: string, size: number): Promise<string | null> {
  const dir = mkdtempSync(join(dataDir(), 'install-'));
  const dest = join(dir, basename(file));
  const hash = createHash('sha256');
  let n = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      n += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(createReadStream(file), tap, createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
  if (hash.digest('hex') !== sha256 || n !== size) {
    rmSync(dir, { recursive: true, force: true });
    return null;
  }
  return dest;
}

/** A download that receives nothing for this long is dropped and resumed later. Generous, because some antivirus holds a download while it scans it. */
const STALL_MS = 2 * 60_000;
/** Waits before trying again after a failure: 5 minutes, 15 minutes, then hourly. */
const RETRY_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];

/** Feed the first `bytes` bytes of `file` into `hash`. */
async function hashFile(hash: Hash, file: string, bytes: number) {
  if (bytes <= 0) return;
  await pipeline(
    createReadStream(file, { end: bytes - 1 }),
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb();
      },
    }),
  );
}

/** Rename, retrying for a few seconds: on Windows an antivirus scan can hold a just-written file. */
async function renameSettled(from: string, to: string) {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to);
    } catch (e) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

export const platformKey = () => `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

export function signedPayload(u: Pick<UpdateInfo, 'version' | 'sha256' | 'size'>, platform = platformKey()) {
  return `wren-update:v1:${u.version}:${platform}:${u.sha256}:${u.size}`;
}

export function verifySignature(u: UpdateInfo, platform = platformKey()): boolean {
  try {
    return verify(null, Buffer.from(signedPayload(u, platform)), PUBLIC_KEY, Buffer.from(u.signature, 'base64'));
  } catch {
    return false;
  }
}

/** What the last install left behind: the version handed to the installer, and that installer's process. */
interface Pending {
  version: string;
  pid?: number;
  /** The installer's program (Windows) or script (macOS), to tell it apart from a reused pid. */
  installer?: string;
  at?: number;
}
/** An installer still running after this long is treated as gone (it never takes nearly this long). */
const INSTALL_MAX_MS = 30 * 60_000;

const pendingPath = () => join(dataDir(), 'update-pending.json');

function readPending(marker = pendingPath()): Pending | null {
  try {
    return JSON.parse(readFileSync(marker, 'utf8')) as Pending;
  } catch {
    return null;
  }
}

/** Replace the marker in one step (a reader never sees half of it). */
function writePending(p: Pending, marker = pendingPath()) {
  const tmp = `${marker}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(p));
  renameSync(tmp, marker);
}

/** Where the installer from the last run of Wren stands: at work, gone, or alive but not identifiable. */
export type InstallerState = 'running' | 'gone' | 'unknown';

export class Updater {
  state: UpdateState = { available: false };
  private busy = false;
  /** Why the previous installation didn't happen; shown with the next ready update. */
  private installFailure?: string;

  constructor(private readonly onChange: () => void) {}

  /**
   * At startup: report an update that was handed to the installer but isn't running now, then
   * delete downloads of versions already installed (each one is a full ~130 MB build) and old
   * install staging.
   */
  cleanup() {
    // Reopened while the installer still runs: its files and its marker are still in use (W-96).
    if (this.installerRunning()) return;
    const pending = pendingPath();
    if (existsSync(pending)) {
      const p = readPending();
      if (p?.version) {
        let why = '';
        try {
          why = readFileSync(join(dataDir(), 'update-failed.txt'), 'utf8').trim();
        } catch {
          /* the installer left no reason */
        }
        if (compareVersions(app.getVersion(), p.version) < 0) {
          this.installFailure = `The last attempt to install ${p.version} failed${why ? ` (${why})` : ''}.`;
          this.state = { available: false, error: this.installFailure };
        }
      }
      rmSync(pending, { force: true });
      rmSync(join(dataDir(), 'update-failed.txt'), { force: true });
    }
    for (const d of readdirSync(dataDir())) if (/^install-/.test(d)) rmSync(join(dataDir(), d), { recursive: true, force: true });
    const root = join(dataDir(), 'updates');
    if (!existsSync(root)) return;
    for (const v of readdirSync(root)) {
      if (/^\d+\.\d+\.\d+/.test(v) && compareVersions(v, app.getVersion()) <= 0) rmSync(join(root, v), { recursive: true, force: true });
    }
  }

  /**
   * Whether the installer the last run of Wren handed off to is still at work: its process is alive
   * and is that installer (not another program that got the pid later). `unknown` (alive, but which
   * program it is couldn't be read) counts as running: a failed check must never let Wren delete
   * files an installer may be using (W-104). The marker's age bounds all of this.
   */
  installerState(marker = pendingPath()): InstallerState {
    const p = readPending(marker);
    if (!p || !Number.isInteger(p.pid) || !p.installer || !p.at || Date.now() - p.at > INSTALL_MAX_MS) return 'gone';
    const alive = () => {
      try {
        process.kill(p.pid!, 0);
        return true;
      } catch {
        return false; // gone, or another user's process (the installer runs as this user)
      }
    };
    if (!alive()) return 'gone';
    let seen = '';
    try {
      seen =
        process.platform === 'win32'
          ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${p.pid}").ExecutablePath`], {
              encoding: 'utf8',
              timeout: 15000,
              windowsHide: true,
            }).trim()
          : execFileSync('/bin/ps', ['-o', 'command=', '-p', String(p.pid)], { encoding: 'utf8', timeout: 5000 }).trim();
    } catch {
      /* couldn't ask */
    }
    if (!seen) return alive() ? 'unknown' : 'gone';
    const same = process.platform === 'win32' ? seen.toLowerCase() === p.installer.toLowerCase() : seen.includes(p.installer);
    return same ? 'running' : 'gone';
  }

  /** The installer may still be at work (running, or alive and not identifiable): leave its files alone. */
  installerRunning(marker?: string): boolean {
    return this.installerState(marker) !== 'gone';
  }

  /** The signed update for this platform, if the server has one newer than `version`. */
  private async latest(version: string): Promise<UpdateInfo | null> {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const res = await net.fetch(`${APP_URL}/api/updates?platform=${process.platform}&arch=${arch}&version=${version}`, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`Update check failed (${res.status})`);
    const info = (await res.json()) as UpdateInfo;
    if (!verifySignature(info)) throw new Error('The update failed signature verification and was ignored.');
    return info;
  }

  /**
   * Look for a newer release and, if there is one, start downloading it. Returns as soon as that's
   * decided; the download carries on in the background and reports progress through `onChange`.
   */
  async check(): Promise<UpdateState> {
    if (this.busy) return this.state;
    if (process.platform !== 'darwin' && process.platform !== 'win32') return this.state;
    this.busy = true;
    let downloading = false;
    try {
      const info = await this.latest(app.getVersion());
      // A validly signed *older* release must never be installed (it could reintroduce fixed bugs).
      if (!info || compareVersions(info.version, app.getVersion()) <= 0) {
        this.succeeded();
        if (!this.state.ready) this.state = { available: false };
        return this.state;
      }
      // Already holding this (or a newer) download: nothing to do. A newer release replaces it.
      if (this.state.ready && compareVersions(info.version, this.state.version ?? '0.0.0') <= 0) return this.state;
      this.state = { available: true, version: info.version, downloading: true, received: 0, total: info.size };
      downloading = true;
      void this.fetchUpdate(info);
      return this.state;
    } catch (e) {
      // A ready download stays installable; the next scheduled check looks again.
      if (!this.state.ready) this.state = { available: false, error: (e as Error).message, retryAt: this.retryLater() };
      return this.state;
    } finally {
      if (!downloading) this.busy = false;
      this.onChange();
    }
  }

  /** The download started by check(). `busy` stays set until it ends. */
  private async fetchUpdate(info: UpdateInfo) {
    try {
      const file = await this.download(info);
      this.succeeded();
      this.state = { available: true, version: info.version, ready: true, file, sha256: info.sha256, size: info.size, ...(this.installFailure && { error: this.installFailure }) };
    } catch (e) {
      this.state = { available: true, version: info.version, downloading: false, error: (e as Error).message, retryAt: this.retryLater() };
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  private failures = 0;
  private retryTimer?: NodeJS.Timeout;

  /** Schedule another try after a failure, backing off. Returns when it will run. */
  private retryLater(): number {
    clearTimeout(this.retryTimer);
    const wait = RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)];
    this.retryTimer = setTimeout(() => void this.check(), wait);
    return Date.now() + wait;
  }

  private succeeded() {
    this.failures = 0;
    clearTimeout(this.retryTimer);
  }

  private reportedAt = 0;

  /** Record download progress; listeners hear about it at most once a second. */
  private progress(received: number) {
    this.state.received = received;
    if (Date.now() - this.reportedAt < 1000) return;
    this.reportedAt = Date.now();
    this.onChange();
  }

  private async download(info: UpdateInfo): Promise<string> {
    if (!/^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//.test(info.url)) throw new Error('Unexpected update host.');
    const dir = join(dataDir(), 'updates', info.version);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, info.url.split('/').pop()!.replace(/[^\w.\-]/g, '_'));
    // Downloaded in an earlier session but not installed yet (Wren was quit): reuse it if it still checks out.
    if (existsSync(file)) {
      const hash = createHash('sha256');
      if (statSync(file).size === info.size) await hashFile(hash, file, info.size);
      if (hash.digest('hex') === info.sha256) return file;
      rmSync(file, { force: true });
    }
    // Bytes land in a .part file, so a dropped or stalled connection resumes where it stopped
    // instead of starting the whole download again. It's named after the signed hash, so a
    // re-published file never resumes from another file's bytes.
    const part = `${file}.${info.sha256.slice(0, 12)}.part`;
    let have = existsSync(part) ? statSync(part).size : 0;
    if (have >= info.size) {
      rmSync(part, { force: true });
      have = 0;
    }
    const ctl = new AbortController();
    let stalled = false;
    let timer: NodeJS.Timeout | undefined;
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        ctl.abort();
      }, STALL_MS);
    };
    let discard = false; // the partial file can't be trusted for resuming
    try {
      alive();
      const res = await net.fetch(info.url, { signal: ctl.signal, cache: 'no-store', headers: have ? { Range: `bytes=${have}-` } : undefined });
      if (res.status === 206) {
        if (!(res.headers.get('content-range') ?? '').startsWith(`bytes ${have}-`)) {
          discard = true;
          throw new Error('The download server sent the wrong part of the file.');
        }
      } else if (res.ok) {
        have = 0; // the whole file is coming
      } else {
        discard = res.status === 416;
        throw new Error(`Download failed (${res.status})`);
      }
      if (!res.body) throw new Error('Download failed (empty response)');
      const hash = createHash('sha256');
      await hashFile(hash, part, have);
      if (have) this.progress(have);
      let received = have;
      const onBytes = (n: number) => this.progress(n);
      const tap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          alive();
          received += chunk.length;
          if (received > info.size) {
            discard = true;
            return cb(new Error('The download is larger than the signed update.'));
          }
          hash.update(chunk);
          onBytes(received);
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as never), tap, createWriteStream(part, { flags: have ? 'a' : 'w' }));
      if (received < info.size) throw new Error('The connection closed before the download finished.');
      if (hash.digest('hex') !== info.sha256) {
        discard = true;
        throw new Error('The downloaded update did not match its signed checksum.');
      }
    } catch (e) {
      if (discard) rmSync(part, { force: true });
      if (stalled) throw new Error(`The download stopped receiving data for ${STALL_MS / 60_000} minutes.`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
    await renameSettled(part, file);
    return file;
  }

  /** `Wren --selftest --update`: download the latest release for this platform through the real path and verify it (CI). */
  async selfTestDownload(): Promise<{ version: string; bytes: number }> {
    const info = await this.latest('0.0.0');
    if (!info) throw new Error('No release for this platform.');
    const file = await this.download(info);
    const bytes = statSync(file).size;
    rmSync(dirname(file), { recursive: true, force: true });
    return { version: info.version, bytes };
  }

  private installing = false;

  /**
   * Quit and install the downloaded update, then relaunch. `stopAgents` resolves true once every
   * agent run, engine and command is confirmed stopped; `resumeAgents` undoes it if the install
   * doesn't go ahead.
   */
  async install(stopAgents: () => Promise<boolean>, resumeAgents: () => void) {
    const file = this.state.file;
    if (!file || !existsSync(file) || this.installing) return;
    this.installing = true;
    let handedOff = false;
    try {
      // Agents (and every process they started) must be gone before anything is staged, so nothing
      // they run is around while the installer is prepared. Where commands aren't sandboxed
      // (Windows) this is what keeps them away from it.
      if (!(await stopAgents().catch(() => false))) {
        this.state = { ...this.state, error: 'Some agent processes could not be confirmed stopped, so the update was not installed. Try again in a moment.' };
        this.onChange();
        return;
      }
      // The file sat on disk since download: install from a private copy that is verified as it's made.
      const copy = this.state.sha256 && this.state.size ? await verifiedCopy(file, this.state.sha256, this.state.size).catch(() => null) : null;
      if (!copy) {
        rmSync(file, { force: true });
        this.state = { available: false, error: 'The downloaded update changed on disk and was discarded. It will be downloaded again.' };
        this.onChange();
        return;
      }
      handedOff = await this.launchInstaller(copy);
    } finally {
      this.installing = false;
      if (!handedOff) resumeAgents();
    }
  }

  /**
   * Start the installer for the verified copy and quit once it is running. False (with the reason
   * in `state.error`) if it couldn't be started, so Wren stays open and agents resume. Whether the
   * installation itself worked is checked at the next start (see cleanup()).
   */
  private async launchInstaller(copy: string): Promise<boolean> {
    const pending = join(dataDir(), 'update-pending.json');
    let cmd: string;
    let args: string[];
    if (process.platform === 'win32') {
      cmd = copy;
      args = ['/S', '--updated', '--force-run'];
    } else {
      // macOS: <bundle>/Contents/MacOS/Wren -> swap the .app after this process exits.
      const bundle = resolve(dirname(process.execPath), '..', '..');
      if (!bundle.endsWith('.app')) return false;
      // Script, archive copy and staging all live in the private folder; the script checks the
      // archive once more right before extracting it, after this process has exited. Any failure
      // puts the old app back, reopens it and leaves the reason for the next start.
      const priv = dirname(copy);
      const script = join(priv, 'install.sh');
      // Paths are passed as arguments, never pasted into the script text.
      writeFileSync(
        script,
        `#!/bin/bash
PID="$1"; FILE="$2"; STAGING="$3"; BUNDLE="$4"; SHA="$5"; REPORT="$6"
fail() { echo "$1" > "$REPORT"; [ -d "$BUNDLE" ] || { [ -d "$BUNDLE.old" ] && mv "$BUNDLE.old" "$BUNDLE"; }; /usr/bin/open "$BUNDLE"; exit 1; }
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
[ "$(/usr/bin/shasum -a 256 "$FILE" | /usr/bin/cut -d' ' -f1)" = "$SHA" ] || fail "the downloaded file changed on disk"
{ rm -rf "$STAGING" && mkdir -p "$STAGING"; } || fail "the update could not be prepared"
/usr/bin/ditto -x -k "$FILE" "$STAGING" || fail "the update could not be unpacked"
NEW="$(/usr/bin/find "$STAGING" -maxdepth 1 -name '*.app' | head -1)"
[ -d "$NEW" ] || fail "the update did not contain the app"
/usr/bin/xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true
rm -rf "$BUNDLE.old"
mv "$BUNDLE" "$BUNDLE.old" || fail "the current app could not be moved aside"
mv "$NEW" "$BUNDLE" || fail "the new app could not be put in place"
rm -rf "$BUNDLE.old" "$STAGING" "$FILE"
/usr/bin/open "$BUNDLE"
`,
        { mode: 0o700, flag: 'wx' },
      );
      cmd = '/bin/bash';
      args = [script, String(process.pid), copy, join(priv, 'staging'), bundle, this.state.sha256!, join(dataDir(), 'update-failed.txt')];
    }
    rmSync(join(dataDir(), 'update-failed.txt'), { force: true });
    writeFileSync(pending, JSON.stringify({ version: this.state.version }));
    const started = await new Promise<Error | null>((done) => {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.once('error', done);
      child.once('spawn', () => {
        child.unref();
        // Which process is installing, so a Wren opened again meanwhile keeps out of its way. The
        // installer already runs, so a failed write can't stop the hand-off (the version-only
        // marker written above stays) (W-105).
        try {
          writePending({ version: this.state.version ?? '', pid: child.pid, installer: process.platform === 'win32' ? cmd : args[0], at: Date.now() }, pending);
        } catch {
          /* best effort */
        }
        done(null);
      });
    });
    if (started) {
      rmSync(pending, { force: true });
      this.state = { ...this.state, error: `The installer could not be started (${started.message}).` };
      this.onChange();
      return false;
    }
    app.quit();
    return true;
  }
}
