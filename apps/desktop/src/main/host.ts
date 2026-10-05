import { desktopCapturer, screen } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { ImageRef, ToolCallData, ToolContext, ToolHost, ToolResult } from '@wren/core';
import { fetchReadable } from '@wren/core/net';
import { BrowserController } from '@wren/core/browser/controller';
import { deviceFetch, deviceJson } from './api';
import { dataDir, type Policy } from './config';
import { listConfined, readConfined, TooLarge, writeConfined } from './confined';
import { allowedRoots, confinePath } from './paths';
import { killTree } from './proctree';
import { hasSeatbelt, seatbeltProfile } from './sandbox';
import { absolutePath, toolEnv } from './shellenv';

// Tool host for runs on this computer. Everything is confined to the folders
// the user allowed in this app's Settings (a policy the server can't change),
// read afresh for every action so a change in Settings applies at once.
// On macOS shell commands and file reads/writes additionally run inside a
// Seatbelt sandbox that only permits those folders (plus toolchains for
// commands) and blocks credential stores.

const MAX_OUT = 60_000;

interface Job {
  proc: ChildProcess;
  out: string;
  exit: number | null;
  started: number;
  /** The run that started it: its jobs (background ones included) end with it. */
  runId: string;
  /** Being stopped; forgotten once it has exited. */
  stopping?: boolean;
}

const jobs = new Map<string, Job>();
let browserCtl: { controller: BrowserController; close: () => Promise<void> } | null = null;

export class LocalHost implements ToolHost {
  readonly runtime = 'desktop' as const;
  readonly imageCache = new Map<string, { mime: string; data: string }>();

  constructor(
    private readonly currentPolicy: () => Policy,
    private readonly runId: string,
    private readonly lease: string,
  ) {}

  private get policy(): Policy {
    return this.currentPolicy();
  }

  // -------------------------------------------------------- paths

  private roots(): string[] {
    return allowedRoots(this.policy.folders);
  }

  /** Resolve a path and require its real target to be inside an allowed folder (symlinks included). */
  resolvePath(p: string): string {
    return confinePath(p, this.roots());
  }

  private read(p: string, max: number) {
    return readConfined(p, this.roots(), dataDir(), max);
  }

  private write(p: string, content: string) {
    return writeConfined(p, Buffer.from(content), this.roots(), dataDir());
  }

  async riskContext(name: string, args: Record<string, unknown>) {
    const unsandboxed = !hasSeatbelt();
    if (name === 'computer.shell') return { unsandboxed };
    if ((name === 'browser.click' || name === 'browser.type' || name === 'browser.press') && browserCtl) {
      // A key press acts on whatever has focus, so describe that element.
      const ref = name === 'browser.press' ? '@focused' : typeof args.ref === 'string' ? args.ref : '';
      const r = ref ? await browserCtl.controller.act({ action: 'describe', ref, tab: this.runId }) : null;
      if (r?.target) return { browserTarget: r.target };
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
        let buf: Buffer;
        try {
          buf = await this.read(p, 8 * 1024 * 1024);
        } catch (e) {
          if (e instanceof TooLarge) return { output: 'File is larger than 8 MB; use the terminal to inspect it.', isError: true };
          throw e;
        }
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
        await this.write(p, s('content'));
        return { output: `Wrote ${Buffer.byteLength(s('content'))} bytes to ${p}.` };
      }
      case 'computer.edit_file': {
        const p = this.resolvePath(s('path'));
        if (!existsSync(p)) return { output: `File not found: ${p}`, isError: true };
        const text = (await this.read(p, 16 * 1024 * 1024)).toString('utf8');
        const count = text.split(s('old_text')).length - 1;
        if (!s('old_text') || count === 0) return { output: 'old_text was not found in the file.', isError: true };
        if (count > 1) return { output: `old_text appears ${count} times; include more context so it is unique.`, isError: true };
        await this.write(p, text.replace(s('old_text'), () => s('new_text')));
        return { output: `Edited ${p}.` };
      }
      case 'computer.list_files': {
        const root = this.resolvePath(s('path') || '.');
        const depth = Math.max(1, Math.min(3, Number(args.depth) || 1));
        const out = await listConfined(root, depth, this.roots(), dataDir());
        return { output: out.join('\n') || '(empty)' };
      }
      case 'computer.share_file': {
        const p = this.resolvePath(s('path'));
        if (!existsSync(p)) return { output: `File not found: ${p}`, isError: true };
        let data: Buffer;
        try {
          data = await this.read(p, 200 * 1024 * 1024);
        } catch (e) {
          if (e instanceof TooLarge) return { output: 'File is larger than 200 MB.', isError: true };
          throw e;
        }
        const a = await this.upload(data, s('name') || p.split(sep).pop() || 'file', 'file');
        return { output: `Shared "${a.name}" (${a.size} bytes) with the user.`, artifacts: [{ id: a.id, name: a.name }] };
      }
      case 'screen.capture':
        return this.captureScreen();
    }
    if (name.startsWith('browser.')) {
      if (!this.policy.browser) return { output: 'Browser use is turned off on this computer.', isError: true };
      return this.browser(name.slice(8), args, ctx.expect);
    }
    if (name.startsWith('mcp_')) return deviceJson<ToolResult>(`/api/device/runs/${this.runId}/mcp`, { name, args }, { lease: this.lease });
    return { output: `Tool ${name} is not available on this computer.`, isError: true };
  }

  // -------------------------------------------------------- shell

  private sandboxProfile(): string {
    return seatbeltProfile(this.roots(), dataDir());
  }

  private async spawnShell(command: string, cwd: string): Promise<ChildProcess> {
    const env = { ...process.env, WREN_AGENT: '1', ELECTRON_RUN_AS_NODE: undefined } as NodeJS.ProcessEnv;
    for (const k of Object.keys(env)) if (/^(WREN_URL|WREN_DATA_DIR)$/.test(k)) delete env[k];
    if (process.platform === 'win32') {
      // Programs are only looked up in absolute PATH folders, never relative to the project.
      for (const k of Object.keys(env)) if (/^path$/i.test(k)) env[k] = absolutePath(env[k] ?? '');
      return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, env, windowsHide: true });
    }
    if (hasSeatbelt()) {
      // Not a login shell: startup files stay unread (and unreadable); PATH and toolchain
      // variables come from toolEnv() instead.
      return spawn('/usr/bin/sandbox-exec', ['-p', this.sandboxProfile(), '/bin/bash', '-c', command], { cwd, env: { ...env, ...(await toolEnv()) }, detached: true });
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
      const proc = await this.spawnShell(command, dir);
      const j: Job = { proc, out: '', exit: null, started: Date.now(), runId: this.runId };
      const add = (b: Buffer) => {
        j.out += b.toString('utf8');
        if (j.out.length > MAX_OUT * 2) j.out = j.out.slice(-MAX_OUT);
      };
      proc.stdout?.on('data', add);
      proc.stderr?.on('data', add);
      proc.on('close', (code) => {
        j.exit = code ?? 1;
        if (j.stopping) jobs.delete(id);
      });
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
        void kill(job.proc);
        return { output: `Timed out after ${Math.round(limit / 1000)}s (stopped).\n${tail(job.out, 6000)}`, isError: true };
      }
      if (ctx.signal?.aborted) {
        void kill(job.proc);
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

  private async browser(action: string, args: Record<string, unknown>, expect?: ToolContext['expect']): Promise<ToolResult> {
    const ctl = await this.controller();
    // `expect` is the element an approval was given for; the controller refuses if the page changed.
    const r = await ctl.act({ ...(args as object), action, tab: this.runId, ...(expect ? { expect } : {}) } as Parameters<BrowserController['act']>[0]);
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
    const res = await deviceFetch('/api/device/artifacts', { method: 'POST', body: form, lease: this.lease });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    return res.json();
  }
}

function tail(s: string, n = 28_000) {
  return s.length > n ? '…' + s.slice(-n) : s;
}

/**
 * Stop a command and everything it started: its process group on macOS/Linux (it runs in its
 * own), the process tree on Windows. A polite stop first, then a forced one after `graceMs`
 * whether or not the first was obeyed (a command can ignore SIGTERM).
 */
function kill(p: ChildProcess, graceMs = 3000): Promise<boolean> {
  if (!p.pid) p.kill();
  return killTree(p, graceMs).catch(() => false);
}

export async function closeBrowser() {
  if (browserCtl) await browserCtl.close().catch(() => {});
  browserCtl = null;
}

/** Wren is quitting: end every command now. */
export function killAllJobs() {
  for (const j of jobs.values()) void kill(j.proc, 0);
  jobs.clear();
}

/** Like killAllJobs, but resolves once every command (and what it started) is confirmed gone. */
export async function stopAllJobs(): Promise<boolean> {
  const all = [...jobs.values()];
  jobs.clear();
  const done = await Promise.all(all.map((j) => kill(j.proc, 0)));
  return done.every(Boolean);
}

/** Stop the commands a run started (foreground or background); other runs' jobs keep going. */
export function killRunJobs(runId?: string) {
  for (const [id, j] of jobs) {
    if (runId && j.runId !== runId) continue;
    if (j.exit !== null) {
      jobs.delete(id);
      continue;
    }
    // Still tracked until it has really exited (so quitting can still reach it).
    j.stopping = true;
    void kill(j.proc);
  }
}

/** Close a finished run's browser tab (other runs keep theirs). */
export async function closeRunTab(runId: string) {
  if (browserCtl) await browserCtl.controller.act({ action: 'close', tab: runId }).catch(() => {});
}
