import { app, net } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, verify, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

export class Updater {
  state: UpdateState = { available: false };
  private busy = false;

  constructor(private readonly onChange: () => void) {}

  /** Delete downloads of versions already installed (each one is a full ~130 MB build) and old install staging. */
  cleanup() {
    for (const d of readdirSync(dataDir())) if (/^install-/.test(d)) rmSync(join(dataDir(), d), { recursive: true, force: true });
    const root = join(dataDir(), 'updates');
    if (!existsSync(root)) return;
    for (const v of readdirSync(root)) {
      if (/^\d+\.\d+\.\d+/.test(v) && compareVersions(v, app.getVersion()) <= 0) rmSync(join(root, v), { recursive: true, force: true });
    }
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
      this.state = { available: true, version: info.version, ready: true, file, sha256: info.sha256, size: info.size };
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
      handedOff = this.launchInstaller(copy);
    } finally {
      this.installing = false;
      if (!handedOff) resumeAgents();
    }
  }

  /** Start the installer for the verified copy and quit; false if that isn't possible here. */
  private launchInstaller(copy: string): boolean {
    if (process.platform === 'win32') {
      spawn(copy, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
      app.quit();
      return true;
    }
    // macOS: <bundle>/Contents/MacOS/Wren -> swap the .app after this process exits.
    const bundle = resolve(dirname(process.execPath), '..', '..');
    if (!bundle.endsWith('.app')) return false;
    // Script, archive copy and staging all live in the private folder; the script checks the
    // archive once more right before extracting it, after this process has exited.
    const priv = dirname(copy);
    const staging = join(priv, 'staging');
    const script = join(priv, 'install.sh');
    // Paths are passed as arguments, never pasted into the script text.
    writeFileSync(
      script,
      `#!/bin/bash
set -e
PID="$1"; FILE="$2"; STAGING="$3"; BUNDLE="$4"; SHA="$5"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
[ "$(/usr/bin/shasum -a 256 "$FILE" | /usr/bin/cut -d' ' -f1)" = "$SHA" ] || exit 1
rm -rf "$STAGING" && mkdir -p "$STAGING"
/usr/bin/ditto -x -k "$FILE" "$STAGING"
NEW="$(/usr/bin/find "$STAGING" -maxdepth 1 -name '*.app' | head -1)"
[ -d "$NEW" ] || exit 1
/usr/bin/xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true
rm -rf "$BUNDLE.old"
mv "$BUNDLE" "$BUNDLE.old"
mv "$NEW" "$BUNDLE"
rm -rf "$BUNDLE.old" "$STAGING" "$FILE"
/usr/bin/open "$BUNDLE"
`,
      { mode: 0o700, flag: 'wx' },
    );
    spawn('/bin/bash', [script, String(process.pid), copy, staging, bundle, this.state.sha256!], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
    return true;
  }
}
