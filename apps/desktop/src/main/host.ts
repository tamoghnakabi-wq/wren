import { desktopCapturer, screen } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { ImageRef, ToolCallData, ToolContext, ToolHost, ToolResult } from '@wren/core';
import { fetchReadable } from '@wren/core/net';
import { BrowserController, registerSelectors } from '@wren/core/browser/controller';
import type { BrowserContext } from 'playwright-core';
import { deviceFetch, deviceJson } from './api';
import { dataDir, type Policy } from './config';
import { listConfined, readConfined, TooLarge, writeConfined } from './confined';
import { allowedRoots, confinePath } from './paths';
import { ended, external, killTree, tracked, treeAlive, type Proc } from './proctree';
import { jobs, kill, release, type Job } from './jobs';
import { spawnContained } from './winjob';
import { hasSeatbelt, seatbeltProfile } from './sandbox';
import { agentEnv, toolEnv } from './shellenv';
import { currentProgramTrust } from './trust';

// Tool host for runs on this computer. Everything is confined to the folders
// the user allowed in this app's Settings (a policy the server can't change),
// read afresh for every action so a change in Settings applies at once.
// On macOS shell commands and file reads/writes additionally run inside a
// Seatbelt sandbox that only permits those folders (plus toolchains for
// commands) and blocks credential stores.

const MAX_OUT = 60_000;

interface AgentBrowser {
  controller: BrowserController;
  close: () => Promise<void>;
  /** Its own process, as the browser reported it at launch; null if unknown (then it can't be confirmed stopped). */
  proc: Proc | null;
}

let browserCtl: AgentBrowser | null = null;
/** Agent browsers Playwright saw close but whose processes weren't seen gone yet; closeBrowser stops them too. */
const strayBrowsers = new Set<Proc>();

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
    if (name === 'computer.shell') return { unsandboxed, trustedProgram: await currentProgramTrust(this.roots()) };
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
    // A minimal environment, never Wren's own (it may hold tokens or startup hooks): see agentEnv().
    const env = agentEnv(process.env, await toolEnv());
    if (process.platform === 'win32') {
      // The command first puts itself in a Job Object, so whatever it starts ends with it (winjob.ts).
      return spawnContained(command, cwd, env);
    }
    if (hasSeatbelt()) {
      // Not a login shell: startup files stay unread (and unreadable); PATH and toolchain
      // variables come from toolEnv() instead.
      return tracked(spawn('/usr/bin/sandbox-exec', ['-p', this.sandboxProfile(), '/bin/bash', '-c', command], { cwd, env, detached: true }));
    }
    return tracked(spawn('/bin/bash', ['-c', command], { cwd, env, detached: true }));
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
        if (j.stopping) void release(id, j);
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
        void release(id, job);
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
      void release(id, job);
      return { output: `Job ${id} finished with exit code ${job.exit}.\n${tail(job.out)}` };
    }
    return { output: `Job ${id} is still running.\n${tail(job.out, 6000)}` };
  }

  // -------------------------------------------------------- browser

  private async controller(): Promise<BrowserController> {
    if (browserCtl) return browserCtl.controller;
    const { chromium, selectors } = await import('playwright-core');
    await registerSelectors(selectors);
    const profile = browserProfile();
    const channels = process.platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'msedge', 'chromium'];
    let lastErr: unknown;
    for (const channel of channels) {
      try {
        const start = Date.now();
        const context = await chromium.launchPersistentContext(profile, { channel, headless: false, viewport: { width: 1280, height: 800 }, args: ['--no-first-run', '--no-default-browser-check'] });
        const ctl = adoptBrowser<AgentBrowser>({ controller: new BrowserController(context), close: () => context.close(), proc: null });
        context.on('close', () => {
          if (browserCtl === ctl) browserCtl = null;
          // Playwright saw it close; anything of it still running is stopped by the next closeBrowser.
          if (ctl.proc) keepUntilGone(ctl.proc);
        });
        ctl.proc = await browserProcess(context, start);
        return ctl.controller;
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

export { killRunJobs, stopAllJobs } from './jobs';

/** The agent browser Wren now owns (what closeBrowser closes). */
export function adoptBrowser<T extends AgentBrowser>(ctl: T): T {
  browserCtl = ctl;
  return ctl;
}

let closingBrowser: Promise<boolean> | null = null;

/**
 * Close the agent browser; true once it's confirmed closed (or wasn't open). It stays known until then, so
 * a later try (an update retried) checks again instead of finding nothing; callers at the same time share
 * one attempt (W-136). Closed or not by Playwright (within `waitMs`), the browser's own processes are
 * then stopped and checked gone: its process group on macOS, its process tree on Windows (W-138, W-139).
 * Nothing here blocks the main process (W-140), and it never rejects.
 */
export function closeBrowser(waitMs = 15_000): Promise<boolean> {
  if (closingBrowser) return closingBrowser;
  if (!browserCtl && !strayBrowsers.size) return Promise.resolve(true);
  closingBrowser = (async () => {
    let ok = true;
    const ctl = browserCtl;
    if (ctl) {
      const closed = await Promise.race([
        ctl.close().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((r) => setTimeout(() => r(false), waitMs).unref()),
      ]);
      const gone = ctl.proc ? await stopBrowserProcs(ctl.proc) : closed;
      if (gone) {
        if (browserCtl === ctl) browserCtl = null;
        if (ctl.proc) strayBrowsers.delete(ctl.proc);
      }
      ok = gone;
    }
    for (const p of [...strayBrowsers]) {
      if (await stopBrowserProcs(p)) strayBrowsers.delete(p);
      else ok = false;
    }
    return ok;
  })()
    .catch(() => false)
    .finally(() => {
      closingBrowser = null;
    });
  return closingBrowser;
}

const browserProfile = () => join(dataDir(), 'agent-browser');

/** Track a closed browser's processes until they're seen gone. */
function keepUntilGone(p: Proc) {
  ended(p);
  strayBrowsers.add(p);
  void treeAlive(p).then(
    (alive) => alive || strayBrowsers.delete(p),
    () => {},
  );
}

/**
 * The agent browser's own process, as the browser itself reports it (W-138). Playwright starts it
 * detached, so on macOS it leads its own process group (and session) with every helper it starts, and it
 * must be Wren's own child. Null if that can't be established.
 */
export async function browserProcess(context: BrowserContext, start: number): Promise<Proc | null> {
  try {
    const browser = context.browser();
    if (!browser) return null;
    const cdp = await browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    await cdp.detach().catch(() => {});
    const pid = processInfo.find((p) => p.type === 'browser')?.id;
    if (!pid) return null;
    if (process.platform !== 'win32' && (await processParent(pid)) !== 'wren') return null;
    return external(pid, start);
  } catch {
    return null;
  }
}

/** Whose child process `pid` is (macOS/Linux): Wren's, another program's, gone, or unknown (ps failed). */
function processParent(pid: number): Promise<'wren' | 'other' | 'gone' | 'unknown'> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 5000 }, (err, out) => {
      const ppid = String(out ?? '').trim();
      if (/^\d+$/.test(ppid)) return resolve(Number(ppid) === process.pid ? 'wren' : 'other');
      resolve(err && (err as { code?: unknown }).code === 1 ? 'gone' : 'unknown');
    });
  });
}

/** Stop what is left of an agent browser; true once nothing of it is left. */
async function stopBrowserProcs(p: Proc): Promise<boolean> {
  if (process.platform !== 'win32') {
    const parent = await processParent(p.pid!);
    // Its id now belongs to another program: Wren's browser and its whole group are gone (an id isn't
    // given out while a group of that number has members), and that program isn't Wren's to stop.
    if (parent === 'other') return true;
    if (parent === 'unknown') return false;
  }
  return killTree(p, 2000, 5000).catch(() => false);
}

/** Close a finished run's browser tab (other runs keep theirs). */
export async function closeRunTab(runId: string) {
  if (browserCtl) {
    // A page the task opened that won't close (a popup included) must not keep running: close the browser.
    const r = await browserCtl.controller.act({ action: 'close', tab: runId }).catch(() => ({ ok: false }));
    if (!r.ok) await closeBrowser();
  }
}
