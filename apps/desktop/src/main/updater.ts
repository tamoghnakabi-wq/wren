import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APP_URL, dataDir } from './config';

// Self-updater. The update endpoint returns {version, url, sha256, size,
// signature}; the signature is ed25519 over a canonical string and is checked
// against the public key built into this app, so a compromised website or
// release host can't push a malicious build. macOS installs by swapping the
// app bundle after quit; Windows runs the per-user NSIS installer silently.

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
  ready?: boolean;
  error?: string;
  file?: string;
  /** Signed checksum/size of `file`, re-checked right before installing. */
  sha256?: string;
  size?: number;
}

/** Compare dotted versions numerically (1.10.0 > 1.9.3). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function sha256File(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), size };
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

  async check(): Promise<UpdateState> {
    if (this.busy) return this.state;
    if (process.platform !== 'darwin' && process.platform !== 'win32') return this.state;
    this.busy = true;
    try {
      const plat = process.platform;
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const res = await fetch(`${APP_URL}/api/updates?platform=${plat}&arch=${arch}&version=${app.getVersion()}`, { signal: AbortSignal.timeout(20000) });
      if (res.status === 204) {
        if (!this.state.ready) this.state = { available: false };
        return this.state;
      }
      if (!res.ok) throw new Error(`Update check failed (${res.status})`);
      const info = (await res.json()) as UpdateInfo;
      if (!verifySignature(info)) throw new Error('The update failed signature verification and was ignored.');
      // A validly signed *older* release must never be installed (it could reintroduce fixed bugs).
      if (compareVersions(info.version, app.getVersion()) <= 0) {
        if (!this.state.ready) this.state = { available: false };
        return this.state;
      }
      // Already holding this (or a newer) download: nothing to do. A newer release replaces it.
      if (this.state.ready && compareVersions(info.version, this.state.version ?? '0') <= 0) return this.state;
      this.state = { available: true, version: info.version, downloading: true };
      this.onChange();
      const file = await this.download(info);
      this.state = { available: true, version: info.version, ready: true, file, sha256: info.sha256, size: info.size };
      return this.state;
    } catch (e) {
      this.state = { ...this.state, downloading: false, error: (e as Error).message };
      return this.state;
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  private async download(info: UpdateInfo): Promise<string> {
    if (!/^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//.test(info.url)) throw new Error('Unexpected update host.');
    const dir = join(dataDir(), 'updates', info.version);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, info.url.split('/').pop()!.replace(/[^\w.\-]/g, '_'));
    const res = await fetch(info.url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const hash = createHash('sha256');
    let size = 0;
    const tap = new (await import('node:stream')).Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as never), tap, createWriteStream(file));
    const digest = hash.digest('hex');
    if (digest !== info.sha256 || size !== info.size) {
      rmSync(file, { force: true });
      throw new Error('The downloaded update did not match its signed checksum.');
    }
    return file;
  }

  /** Quit and install the downloaded update, then relaunch. */
  async install(beforeQuit: () => void) {
    const file = this.state.file;
    if (!file || !existsSync(file)) return;
    // The file sat on disk since download: verify it is still exactly what was signed.
    const now = await sha256File(file);
    if (now.sha256 !== this.state.sha256 || now.size !== this.state.size) {
      rmSync(file, { force: true });
      this.state = { available: false, error: 'The downloaded update changed on disk and was discarded. It will be downloaded again.' };
      this.onChange();
      return;
    }
    if (process.platform === 'win32') {
      spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
      beforeQuit();
      app.quit();
      return;
    }
    // macOS: <bundle>/Contents/MacOS/Wren -> swap the .app after this process exits.
    const bundle = resolve(dirname(process.execPath), '..', '..');
    if (!bundle.endsWith('.app')) return;
    const staging = join(dirname(file), 'staging');
    const script = join(dirname(file), 'install.sh');
    // Paths are passed as arguments, never pasted into the script text.
    writeFileSync(
      script,
      `#!/bin/bash
set -e
PID="$1"; FILE="$2"; STAGING="$3"; BUNDLE="$4"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
rm -rf "$STAGING" && mkdir -p "$STAGING"
/usr/bin/ditto -x -k "$FILE" "$STAGING"
NEW="$(/usr/bin/find "$STAGING" -maxdepth 1 -name '*.app' | head -1)"
[ -d "$NEW" ] || exit 1
/usr/bin/xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true
rm -rf "$BUNDLE.old"
mv "$BUNDLE" "$BUNDLE.old"
mv "$NEW" "$BUNDLE"
rm -rf "$BUNDLE.old" "$STAGING"
/usr/bin/open "$BUNDLE"
`,
      { mode: 0o755 },
    );
    spawn('/bin/bash', [script, String(process.pid), file, staging, bundle], { detached: true, stdio: 'ignore' }).unref();
    beforeQuit();
    app.quit();
  }
}
