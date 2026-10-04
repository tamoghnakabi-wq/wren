import { desktopCapturer, screen } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ImageRef, ToolCallData, ToolContext, ToolHost, ToolResult } from '@wren/core';
import { fetchReadable } from '@wren/core/net';
import { BrowserController } from '@wren/core/browser/controller';
import { deviceFetch, deviceJson } from './api';
import { dataDir, type Policy } from './config';

// Tool host for runs on this computer. Everything is confined to the folders
// the user allowed in this app's Settings (a policy the server can't change).
// On macOS shell commands additionally run inside a Seatbelt sandbox that only
// permits writes to those folders and blocks reads of credential stores.

const MAX_OUT = 60_000;

interface Job {
  proc: ChildProcess;
  out: string;
  exit: number | null;
  started: number;
}

const jobs = new Map<string, Job>();
let browserCtl: { controller: BrowserController; close: () => Promise<void> } | null = null;

export class LocalHost implements ToolHost {
  readonly runtime = 'desktop' as const;
  readonly imageCache = new Map<string, { mime: string; data: string }>();

  constructor(
    private readonly policy: Policy,
    private readonly runId: string,
    private readonly lease: string,
  ) {}

  // -------------------------------------------------------- paths

  private roots(): string[] {
    return this.policy.folders.map((f) => {
      try {
        return realpathSync(f);
      } catch {
        return resolve(f);
      }
    });
  }

  /** Resolve a path and require it to be inside an allowed folder (no symlink escapes). */
  resolvePath(p: string): string {
    const roots = this.roots();
    if (!roots.length) throw new Error('No folders are allowed on this computer. Add one in Wren → Settings → This computer.');
    const expanded = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(roots[0], expanded || '.');
    // Resolve the deepest existing ancestor to catch symlinks.
    let probe = abs;
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    let real = probe;
    try {
      real = realpathSync(probe);
    } catch {
      /* keep */
    }
    const full = resolve(real, relative(probe, abs));
    const inside = roots.some((r) => full === r || full.startsWith(r.endsWith(sep) ? r : r + sep));
    if (!inside) throw new Error(`"${p}" is outside the folders you allowed (${roots.join(', ')}).`);
    return full;
  }

  async riskContext(name: string, args: Record<string, unknown>) {
    const unsandboxed = process.platform === 'win32' || (process.platform === 'darwin' && !existsSync('/usr/bin/sandbox-exec'));
    if (name === 'computer.shell') return { unsandboxed };
    if ((name === 'browser.click' || name === 'browser.type' || name === 'browser.press') && browserCtl && typeof args.ref === 'string') {
      const r = await browserCtl.controller.act({ action: 'describe', ref: args.ref });
      if (r.target) return { browserTarget: r.target };
    }
    if (name === 'computer.write_file' && typeof args.path === 'string') {
      try {
        return { fileExists: existsSync(this.resolvePath(args.path)) };
      } catch {
        return { fileExists: false };
      }
    }
    return {};
  }

  // -------------------------------------------------------- dispatch

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext, resume?: ToolCallData['background']): Promise<ToolResult | { yield: true }> {
    const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
    switch (name) {
      case 'web.fetch': {
        const r = await fetchReadable(s('url'), { guard: true, maxChars: Number(args.max_chars) || 40000 });
        return { output: r.output, isError: r.status >= 400 };
      }
      case 'github.request':
        return deviceJson<ToolResult>(`/api/device/runs/${this.runId}/github`, { method: s('method') || 'GET', path: s('path'), body: args.body }, { lease: this.lease });
      case 'computer.shell':
        if (!this.policy.shell) return { output: 'Terminal access is turned off on this computer (Wren → Settings → This computer).', isError: true };
        return this.shell(s('command'), s('cwd'), Number(args.timeout_sec) || 120, !!args.background, ctx, resume);
      case 'computer.shell_status':
        return this.jobStatus(s('job_id'), Math.min(Number(args.wait_sec) || 0, 600), ctx);
      case 'computer.read_file': {
        const p = this.resolvePath(s('path'));
        if (!existsSync(p)) return { output: `File not found: ${p}`, isError: true };
        const buf = readFileSync(p);
        if (buf.byteLength > 8 * 1024 * 1024) return { output: 'File is larger than 8 MB; use the terminal to inspect it.', isError: true };
        if (buf.includes(0)) return { output: `${p} looks like a binary file (${buf.byteLength} bytes).`, isError: true };
        const lines = buf.toString('utf8').split('\n');
        const start = Math.max(1, Number(args.offset) || 1);
        const limit = Math.min(Number(args.limit) || 400, 2000);
        const slice = lines.slice(start - 1, start - 1 + limit);
        const more = start - 1 + slice.length < lines.length ? `\n[lines ${start}-${start + slice.length - 1} of ${lines.length}]` : '';
        return { output: slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n') + more };
      }
      case 'computer.write_file': {
        const p = this.resolvePath(s('path'));
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, s('content'));
        return { output: `Wrote ${Buffer.byteLength(s('content'))} bytes to ${p}.` };
      }
      case 'computer.edit_file': {
        const p = this.resolvePath(s('path'));
        if (!existsSync(p)) return { output: `File not found: ${p}`, isError: true };
        const text = readFileSync(p, 'utf8');
        const count = text.split(s('old_text')).length - 1;
        if (!s('old_text') || count === 0) return { output: 'old_text was not found in the file.', isError: true };
        if (count > 1) return { output: `old_text appears ${count} times; include more context so it is unique.`, isError: true };
        writeFileSync(p, text.replace(s('old_text'), () => s('new_text')));
        return { output: `Edited ${p}.` };
      }
      case 'computer.list_files': {
        const root = this.resolvePath(s('path') || '.');
        const depth = Math.max(1, Math.min(3, Number(args.depth) || 1));
        const out: string[] = [];
        const walk = (d: string, level: number) => {
          if (out.length > 500) return;
          for (const name of readdirSync(d)) {
            if (name === 'node_modules' || name === '.git') continue;
            const full = join(d, name);
            let st;
            try {
              st = statSync(full);
            } catch {
              continue;
            }
            out.push(`${st.isDirectory() ? 'd' : 'f'} ${st.size} ${full}`);
            if (st.isDirectory() && level < depth) walk(full, level + 1);
          }
        };
        walk(root, 1);
        return { output: out.join('\n') || '(empty)' };
      }
      case 'computer.share_file': {
        const p = this.resolvePath(s('path'));
        if (!existsSync(p)) return { output: `File not found: ${p}`, isError: true };
        const a = await this.upload(readFileSync(p), s('name') || p.split(sep).pop() || 'file', 'file');
        return { output: `Shared "${a.name}" (${a.size} bytes) with the user.`, artifacts: [{ id: a.id, name: a.name }] };
      }
      case 'screen.capture':
        return this.captureScreen();
    }
    if (name.startsWith('browser.')) {
      if (!this.policy.browser) return { output: 'Browser use is turned off on this computer.', isError: true };
      return this.browser(name.slice(8), args);
    }
    if (name.startsWith('mcp_')) return deviceJson<ToolResult>(`/api/device/runs/${this.runId}/mcp`, { name, args }, { lease: this.lease });
    return { output: `Tool ${name} is not available on this computer.`, isError: true };
  }

  // -------------------------------------------------------- shell

  private sandboxProfile(): string {
    const home = homedir();
    const q = (p: string) => JSON.stringify(p);
    const writable = [...this.roots(), realpathSync(tmpdir()), '/private/tmp', '/private/var/folders', join(home, '.npm'), join(home, '.cache'), join(home, 'Library/Caches'), join(home, '.cargo/registry'), join(home, '.bun/install')];
    const secret = [join(home, '.ssh'), join(home, '.aws'), join(home, '.gnupg'), join(home, '.config/gh'), join(home, 'Library/Keychains'), join(home, 'Library/Cookies'), join(home, 'Library/Messages'), join(home, 'Library/Mail'), join(home, 'Library/Application Support/Google/Chrome'), join(home, 'Library/Application Support/Firefox'), join(home, 'Library/Safari'), join(home, '.codex'), join(home, '.claude'), join(home, '.grok'), dataDir()];
    return [
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      `(allow file-write* ${writable.map((p) => `(subpath ${q(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))`,
      `(deny file-read* ${secret.map((p) => `(subpath ${q(p)})`).join(' ')})`,
    ].join('\n');
  }

  private spawnShell(command: string, cwd: string): ChildProcess {
    const env = { ...process.env, WREN_AGENT: '1', ELECTRON_RUN_AS_NODE: undefined } as NodeJS.ProcessEnv;
    for (const k of Object.keys(env)) if (/^(WREN_URL|WREN_DATA_DIR)$/.test(k)) delete env[k];
    if (process.platform === 'win32') {
      return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, env, windowsHide: true });
    }
    if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
      return spawn('/usr/bin/sandbox-exec', ['-p', this.sandboxProfile(), '/bin/bash', '-lc', command], { cwd, env, detached: true });
    }
    return spawn('/bin/bash', ['-lc', command], { cwd, env, detached: true });
  }

  private async shell(command: string, cwd: string, timeoutSec: number, background: boolean, ctx: ToolContext, resume?: ToolCallData['background']): Promise<ToolResult | { yield: true }> {
    let id = resume?.kind === 'job' ? resume.handle : '';
    let job = id ? jobs.get(id) : undefined;
    if (id && !job) return { output: 'The command was interrupted (Wren restarted while it was running).', isError: true };
    if (!job) {
      if (!command.trim()) return { output: 'Empty command.', isError: true };
      const dir = this.resolvePath(cwd || '.');
      id = randomUUID().slice(0, 8);
      const proc = this.spawnShell(command, dir);
      const j: Job = { proc, out: '', exit: null, started: Date.now() };
      const add = (b: Buffer) => {
        j.out += b.toString('utf8');
        if (j.out.length > MAX_OUT * 2) j.out = j.out.slice(-MAX_OUT);
      };
      proc.stdout?.on('data', add);
      proc.stderr?.on('data', add);
      proc.on('close', (code) => (j.exit = code ?? 1));
      proc.on('error', (e) => {
        j.out += `\n${e.message}`;
        j.exit = 127;
      });
      jobs.set(id, j);
      job = j;
      if (background) return { output: `Started background job ${id}. Check it with computer.shell_status.`, meta: { job: id } };
      await ctx.checkpoint({ kind: 'job', handle: id, startedAt: j.started });
    }
    const limit = Math.min(Math.max(timeoutSec, 5), 1800) * 1000;
    for (;;) {
      if (job.exit !== null) {
        jobs.delete(id);
        return { output: `exit code ${job.exit}\n${tail(job.out) || '(no output)'}`, isError: job.exit !== 0 };
      }
      if (Date.now() - job.started > limit) {
        kill(job.proc);
        return { output: `Timed out after ${Math.round(limit / 1000)}s (stopped).\n${tail(job.out, 6000)}`, isError: true };
      }
      if (ctx.signal?.aborted) {
        kill(job.proc);
        return { output: 'Stopped.', isError: true };
      }
      if (Date.now() > ctx.deadline - 3000) return { yield: true };
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  private async jobStatus(id: string, waitSec: number, ctx: ToolContext): Promise<ToolResult> {
    const job = jobs.get(id);
    if (!job) return { output: 'Unknown or finished job id.', isError: true };
    const until = Math.min(Date.now() + waitSec * 1000, ctx.deadline - 3000);
    while (job.exit === null && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
    if (job.exit !== null) {
      jobs.delete(id);
      return { output: `Job ${id} finished with exit code ${job.exit}.\n${tail(job.out)}` };
    }
    return { output: `Job ${id} is still running.\n${tail(job.out, 6000)}` };
  }

  // -------------------------------------------------------- browser

  private async controller(): Promise<BrowserController> {
    if (browserCtl) return browserCtl.controller;
    const { chromium } = await import('playwright-core');
    const profile = join(dataDir(), 'agent-browser');
    const channels = process.platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'msedge', 'chromium'];
    let lastErr: unknown;
    for (const channel of channels) {
      try {
        const context = await chromium.launchPersistentContext(profile, { channel, headless: false, viewport: { width: 1280, height: 800 }, args: ['--no-first-run', '--no-default-browser-check'] });
        browserCtl = {
          controller: new BrowserController(context),
          close: () => context.close(),
        };
        context.on('close', () => (browserCtl = null));
        return browserCtl.controller;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`Could not open a browser. Install Google Chrome or Microsoft Edge. (${(lastErr as Error)?.message?.split('\n')[0]})`);
  }

  private async browser(action: string, args: Record<string, unknown>): Promise<ToolResult> {
    const ctl = await this.controller();
    const r = await ctl.act({ ...(args as object), action } as Parameters<BrowserController['act']>[0]);
    if (r.preview) {
      deviceJson(`/api/device/runs/${this.runId}/live`, { image: r.preview, url: r.url, title: r.title }, { lease: this.lease }).catch(() => {});
    }
    const images: ImageRef[] = [];
    if (r.image) {
      const a = await this.upload(Buffer.from(r.image, 'base64'), `screenshot-${Date.now()}.jpg`, 'screenshot');
      this.imageCache.set(a.id, { mime: 'image/jpeg', data: r.image });
      images.push({ artifactId: a.id, mime: 'image/jpeg' });
    }
    const text = r.ok ? r.snapshot ?? (r.image ? `Screenshot of ${r.title ?? ''} (${r.url ?? ''})` : 'Done.') : `Browser error: ${r.error}\n${r.snapshot ?? ''}`;
    return { output: text, isError: !r.ok, images };
  }

  // -------------------------------------------------------- screen + files

  private async captureScreen(): Promise<ToolResult> {
    if (!this.policy.screen) return { output: 'Screen capture is turned off on this computer.', isError: true };
    const { width, height } = screen.getPrimaryDisplay().size;
    const scale = Math.min(1, 1600 / width);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) } });
    const img = sources[0]?.thumbnail;
    if (!img || img.isEmpty()) return { output: 'Could not capture the screen. On macOS, allow Wren in System Settings → Privacy & Security → Screen Recording.', isError: true };
    const jpeg = img.toJPEG(70);
    const a = await this.upload(jpeg, `screen-${Date.now()}.jpg`, 'screenshot');
    const data = jpeg.toString('base64');
    this.imageCache.set(a.id, { mime: 'image/jpeg', data });
    return { output: 'Captured the screen.', images: [{ artifactId: a.id, mime: 'image/jpeg' }] };
  }

  private async upload(data: Buffer, name: string, kind: 'file' | 'screenshot'): Promise<{ id: string; name: string; size: number }> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)]), name);
    form.append('runId', this.runId);
    form.append('kind', kind);
    const res = await deviceFetch('/api/device/artifacts', { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    return res.json();
  }
}

function tail(s: string, n = 28_000) {
  return s.length > n ? '…' + s.slice(-n) : s;
}

function kill(p: ChildProcess) {
  try {
    if (process.platform !== 'win32' && p.pid) process.kill(-p.pid, 'SIGTERM');
    else p.kill();
  } catch {
    p.kill();
  }
}

export async function closeBrowser() {
  if (browserCtl) await browserCtl.close().catch(() => {});
  browserCtl = null;
}

export function killAllJobs() {
  for (const j of jobs.values()) kill(j.proc);
  jobs.clear();
}
