import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
    if (this.busy || this.state.ready) return this.state;
    if (process.platform !== 'darwin' && process.platform !== 'win32') return this.state;
    this.busy = true;
    try {
      const plat = process.platform;
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const res = await fetch(`${APP_URL}/api/updates?platform=${plat}&arch=${arch}&version=${app.getVersion()}`, { signal: AbortSignal.timeout(20000) });
      if (res.status === 204) {
        this.state = { available: false };
        return this.state;
      }
      if (!res.ok) throw new Error(`Update check failed (${res.status})`);
      const info = (await res.json()) as UpdateInfo;
      if (!verifySignature(info)) throw new Error('The update failed signature verification and was ignored.');
      this.state = { available: true, version: info.version, downloading: true };
      this.onChange();
      const file = await this.download(info);
      this.state = { available: true, version: info.version, ready: true, file };
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
  install(beforeQuit: () => void) {
    const file = this.state.file;
    if (!file || !existsSync(file)) return;
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
    writeFileSync(
      script,
      `#!/bin/bash
set -e
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
rm -rf "${staging}" && mkdir -p "${staging}"
/usr/bin/ditto -x -k "${file}" "${staging}"
NEW="$(/usr/bin/find "${staging}" -maxdepth 1 -name '*.app' | head -1)"
[ -d "$NEW" ] || exit 1
/usr/bin/xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true
rm -rf "${bundle}.old"
mv "${bundle}" "${bundle}.old"
mv "$NEW" "${bundle}"
rm -rf "${bundle}.old" "${staging}"
/usr/bin/open "${bundle}"
`,
      { mode: 0o755 },
    );
    spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
    beforeQuit();
    app.quit();
  }
}
