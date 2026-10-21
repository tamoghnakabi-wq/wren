import { cleanUp } from '../cleanup';
import { db } from '../db';
import { Sandbox } from '@vercel/sandbox';
import { createHash, randomUUID } from 'node:crypto';
import type { ImageRef, ToolCallData, ToolContext, ToolHost, ToolResult } from '@wren/core';
import { BROWSER_DAEMON_TS } from '@wren/core/browser/daemon-source';
import { fetchReadable } from '@wren/core/net';
import { assessGithub, MAX_TOOL_OUTPUT } from '@wren/core';
import { guessMime, saveArtifact } from '../blob';
import { callMcp, type McpToolInfo } from '../mcp';
import { env } from '../env';
import { commandOutput, MB, readCapped, type CappedRead } from './capped-read';

/**
 * How Wren runs its own commands in the agent's computer: without login or startup files, which are the agent's
 * to write and could print anything into this function (W-191). The agent's own commands (run.sh) still get a
 * login shell. What Wren reads back is also capped (`commandOutput`), as the agent can change any program there.
 */
const WREN_SH = ['--noprofile', '--norc', '-c'];

// Tool host for cloud runs. The agent's computer is a persistent Vercel
// Sandbox (one per agent); the model loop and every credential stay in our
// functions, never inside the VM. web.fetch and github.request run here with
// guards; everything else is a command or file operation in the sandbox.
//
// The browser runs in a second VM of its own. Its control endpoint is only
// reachable from inside that VM, which agent commands never run in, so a shell
// command can't drive the browser around the approval checks (or read its
// cookies); only this host's browser tools can.

export const WORKSPACE = '/vercel/sandbox';
const JOB_DIR = '$HOME/.wren/jobs';

// The most of a file the file tools take into this function (W-191), counted while it streams in.
// read_file as on the desktop; edit_file decodes and searches the whole text, so less; share_file
// what a desktop may upload.
const READ_MAX = 8 * MB;
const EDIT_MAX = 5 * MB;
const SHARE_MAX = 50 * MB;
/** Characters of one line read_file shows, and of its whole answer (room left for its notes). */
const LINE_MAX = 2000;
const READ_OUTPUT_MAX = MAX_TOOL_OUTPUT - 1000;

/** Changes whenever the daemon code does, so a stale daemon in a persistent VM gets replaced. */
const DAEMON_VERSION = createHash('sha256').update(BROWSER_DAEMON_TS).digest('hex').slice(0, 16);
/**
 * POST stdin (JSON) to the browser daemon's /act. The daemon only serves requests with the token it
 * wrote at its start (W-169), sent from that file so it's never on a command line; a daemon from
 * before that (replaced at the next browser use) has no file and takes the request without it.
 */
const ACT = (seconds: number) => `t="$HOME/.wren/browser.token"; h=(); [ -f "$t" ] && h=(-H "@$t"); curl -s -m ${seconds} -X POST -H 'content-type: application/json' "\${h[@]}" --data-binary @- http://127.0.0.1:9333/act`;
const HEALTH = `[ "$(cat "$HOME/.wren/browser.version" 2>/dev/null)" = "${DAEMON_VERSION}" ] && curl -s -m 2 http://127.0.0.1:9333/health`;

// The command runs in a session of its own; its id ($id.sid) is what stopping a job kills,
// so everything the command started goes with it. $id.run names the run that owns the job.
const RUN_SH = `#!/bin/bash
# usage: run.sh <id> <cwd> <command> [run id]
id="$1"; cwd="$2"; cmd="$3"
dir="$HOME/.wren/jobs"; mkdir -p "$dir"
cd "$cwd" 2>/dev/null || cd ${WORKSPACE}
echo $$ > "$dir/$id.pid"
[ -n "$4" ] && echo "$4" > "$dir/$id.run"
setsid -w bash -c 'echo $$ > "$0"; exec bash -lc "$1"' "$dir/$id.sid" "$cmd" > "$dir/$id.log" 2>&1 < /dev/null
echo $? > "$dir/$id.exit"
`;

/**
 * Shell function `jobnum <file>`: prints the number a job file holds, or nothing if it doesn't hold one.
 * The agent can write these files, and whatever a command prints is collected whole by the SDK (W-191),
 * so at most 32 bytes are read, only from a regular file (not a pipe or a device), and only digits count.
 */
const JOB_NUM = `jobnum() { local v; [ -f "$1" ] || return 0; v=$(head -c 32 -- "$1" 2>/dev/null)
  case "$v" in ''|*[!0-9]*) return 0 ;; esac; [ \${#v} -le 10 ] && printf '%s' "$v"; return 0; }`;

/** Shell function `stopjob <id>`: ends a job's whole session, politely first. */
const STOP_JOB = `${JOB_NUM}
stopjob() { d="$HOME/.wren/jobs"; s=$(jobnum "$d/$1.sid"); p=$(jobnum "$d/$1.pid")
  [ -n "$s" ] && { kill -TERM -- -"$s"; pkill -TERM -s "$s"; } 2>/dev/null; [ -n "$p" ] && kill -TERM "$p" 2>/dev/null
  sleep 1; [ -n "$s" ] && { kill -KILL -- -"$s"; pkill -KILL -s "$s"; } 2>/dev/null; true; }
jobalive() { d="$HOME/.wren/jobs"; s=$(jobnum "$d/$1.sid")
  { [ -n "$s" ] && pgrep -s "$s" >/dev/null; } || { [ ! -f "$d/$1.exit" ] && p=$(jobnum "$d/$1.pid") && [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }; }`;

/** Stops every job of run $1 and exits 0 only once none of their processes is left. */
const STOP_RUN_JOBS = `${STOP_JOB}
left=0
for f in "$HOME"/.wren/jobs/*.run; do
  [ -f "$f" ] && [ "$(cat "$f")" = "$1" ] || continue
  j="$(basename "$f" .run)"
  stopjob "$j"
  for i in 1 2 3 4 5 6 7 8 9 10; do jobalive "$j" || break; sleep 0.3; done
  jobalive "$j" && { echo "job $j still running" >&2; left=1; }
done
exit $left`;

// One-time browser install in the browser VM. It takes minutes on a new VM, so it runs in the
// background (a long silent command would outlive its connection) and is polled with
// BROWSER_STATE, which prints ok | running | failed (+ log tail) and (re)starts it when needed.
const BROWSER_SETUP = `set -e
mkdir -p "$HOME/.wren" && cd "$HOME/.wren"
if [ ! -d node_modules/playwright ]; then
  echo '{"type":"module","private":true}' > package.json
  npm install --no-audit --no-fund playwright@1.63.0
fi
if [ ! -f .chromium-ok ]; then
  sudo -E env "PATH=$PATH" npx --yes playwright@1.63.0 install-deps chromium || true
  npx --yes playwright@1.63.0 install chromium
  touch .chromium-ok
fi
`;
const BROWSER_STATE = `cd "$HOME/.wren"
if [ -f .chromium-ok ] && [ -d node_modules/playwright ]; then echo ok; exit 0; fi
p=$(cat setup.pid 2>/dev/null); if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo running; exit 0; fi
if [ -f setup.exit ]; then e=$(cat setup.exit); rm -f setup.exit; if [ "$e" != 0 ]; then echo failed; tail -c 600 setup.log; exit 0; fi; fi
(setsid nohup bash -c 'echo $$ > "$HOME/.wren/setup.pid"; bash "$HOME/.wren/setup.sh" > "$HOME/.wren/setup.log" 2>&1; echo $? > "$HOME/.wren/setup.exit"' >/dev/null 2>&1 < /dev/null &)
echo running`;

const STOP_BROWSER = `pkill -f "node [b]rowser.ts" 2>/dev/null
for i in $(seq 1 20); do pgrep -f "node [b]rowser.ts" >/dev/null || break; sleep 0.25; done
pkill -9 -f "node [b]rowser.ts" 2>/dev/null; pkill -9 -f "[m]s-playwright/chromium" 2>/dev/null
rm -f "$HOME/.wren/profile/Singleton"*; mkdir -p "$HOME/.wren"; echo "$HOME"`;

class BrowserNotReady extends Error {}

export interface SandboxHostOptions {
  agentId: string;
  userId: string;
  sessionId: string;
  runId: string;
  /** The tick's lease: files the run produces are recorded only while it holds the run. */
  leaseId?: string;
  githubToken?: string;
  /** namespace -> connected MCP server */
  mcp?: Map<string, { url: string; token?: string; tools: McpToolInfo[] }>;
  onLiveView?: (preview: { data: string; url?: string; title?: string }) => Promise<void>;
}

export class SandboxHost implements ToolHost {
  readonly runtime = 'cloud' as const;
  private sandbox: Sandbox | null = null;
  private browserBox: Sandbox | null = null;
  private ready = false;
  private browserReady = false;
  private home = '/home/ubuntu';
  /** images produced this tick, so the next model call doesn't refetch them */
  readonly imageCache = new Map<string, { mime: string; data: string }>();

  constructor(private readonly o: SandboxHostOptions) {}

  static sandboxName(agentId: string) {
    return `wren-agent-${agentId}`;
  }

  static browserName(agentId: string) {
    return `wren-browser-${agentId}`;
  }

  /**
   * Get (or make) one of the agent's computers. Not for a removed agent: checked before, and again after
   * (a removal that landed meanwhile gets what was just made deleted too), so a tick that started before
   * the agent was removed can't leave a computer behind (W-158, W-157).
   */
  private static async vm(name: string, agentId: string, role: string) {
    const live = async () => (await db()`select 1 from public.agents where id = ${agentId} and archived_at is null`).length > 0;
    if (!(await live())) throw new Error('The agent was removed.');
    const sb = await SandboxHost.getOrCreateVm(name, agentId, role);
    if (!(await live())) {
      await cleanUp('sandbox', name);
      throw new Error('The agent was removed.');
    }
    return sb;
  }

  private static getOrCreateVm(name: string, agentId: string, role: string) {
    return Sandbox.getOrCreate({
      name,
      image: 'vercel/sandbox/universal',
      region: env.sandboxRegion,
      timeout: 45 * 60 * 1000,
      resources: { vcpus: 2 },
      keepLastSnapshots: { count: 1, deleteEvicted: true },
      snapshotExpiration: 30 * 24 * 60 * 60 * 1000,
      tags: { app: 'wren', agent: agentId.slice(0, 32), role },
    });
  }

  /**
   * Delete an agent's computers and their snapshots (agent or account deletion). One that can't be
   * deleted now is kept and retried by the cron (W-157); one that never existed is fine.
   */
  static async deleteComputers(agentId: string) {
    for (const name of [SandboxHost.sandboxName(agentId), SandboxHost.browserName(agentId)]) await cleanUp('sandbox', name);
  }

  /**
   * End what a run left on its VMs: its shell jobs (foreground or background; other runs' jobs
   * keep going) and its browser tab. True once confirmed, or when there is nothing to clean (the
   * VM is gone or stopped, so nothing runs); false on a transient failure, so the caller retries.
   */
  static async endRun(agentId: string, runId: string): Promise<boolean> {
    const gone = (e: unknown) => (e as { response?: Response }).response?.status === 404;
    try {
      const sb = await Sandbox.get({ name: SandboxHost.sandboxName(agentId), resume: false });
      if (sb.status === 'running') {
        const r = await sb.runCommand({ cmd: 'bash', args: [...WREN_SH, STOP_RUN_JOBS, 'stop', runId] });
        if (r.exitCode !== 0) return false;
      }
    } catch (e) {
      if (!gone(e)) return false;
    }
    try {
      const br = await Sandbox.get({ name: SandboxHost.browserName(agentId), resume: false });
      if (br.status === 'running') {
        // Closed only when the browser says so. Nothing listening (curl 7) means no browser, so no tab.
        const payload = Buffer.from(JSON.stringify({ action: 'close', tab: runId })).toString('base64');
        const r = await br.runCommand({
          cmd: 'bash',
          args: ['-lc', `out=$(echo ${payload} | base64 -d | { ${ACT(10)}; }); c=$?\n[ $c -eq 7 ] && exit 0\n[ $c -eq 0 ] && printf '%s' "$out" | grep -q '"ok":true' && exit 0\nexit 1`],
        });
        if (r.exitCode !== 0) return false;
      }
    } catch (e) {
      if (!gone(e)) return false;
    }
    return true;
  }

  async computer(): Promise<Sandbox> {
    if (this.sandbox && this.ready) return this.sandbox;
    this.sandbox = await SandboxHost.vm(SandboxHost.sandboxName(this.o.agentId), this.o.agentId, 'computer');
    // Idempotent per session: helper scripts live in $HOME/.wren.
    const setup = await this.sandbox.runCommand({
      cmd: 'bash',
      // Older versions ran the browser in this VM: stop it and drop its profile (cookies) for good.
      args: [...WREN_SH, `pkill -f "node [b]rowser.ts" 2>/dev/null; rm -rf "$HOME/.wren/profile" "$HOME/.wren/browser.ts" "$HOME/.wren/browser.version"; mkdir -p ${WORKSPACE} "$HOME/.wren/jobs" && cat > "$HOME/.wren/run.sh" <<'WREN_EOF'\n${RUN_SH}WREN_EOF\nchmod +x "$HOME/.wren/run.sh" && echo "$HOME"`],
    });
    this.home = (await commandOutput(setup, 4096)).stdout.trim().split('\n').pop() || this.home;
    this.ready = true;
    return this.sandbox;
  }

  private async browserVm(): Promise<Sandbox> {
    if (!this.browserBox) this.browserBox = await SandboxHost.vm(SandboxHost.browserName(this.o.agentId), this.o.agentId, 'browser');
    return this.browserBox;
  }

  /** Stop the agent's computer and browser (their filesystems are snapshotted automatically). */
  async stop() {
    const names = [SandboxHost.sandboxName(this.o.agentId), SandboxHost.browserName(this.o.agentId)];
    const held = [this.sandbox, this.browserBox];
    await Promise.all(
      names.map(async (name, i) => {
        try {
          const sb = held[i] ?? (await Sandbox.get({ name, resume: false }));
          if (sb.status === 'running' || sb.status === 'pending') await sb.stop();
        } catch {
          // never created, already stopped, or gone
        }
      }),
    );
  }

  async riskContext(name: string, args: Record<string, unknown>) {
    if (name.startsWith('mcp_')) {
      const [ns, tool] = [name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1)];
      const t = this.o.mcp?.get(ns)?.tools.find((x) => x.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) === tool);
      return { mcpReadOnly: !!t?.readOnly };
    }
    if (name === 'browser.click' || name === 'browser.type' || name === 'browser.press') {
      // A fresh tick doesn't know yet whether the browser from an earlier tick is still up.
      if (!this.browserReady) {
        const sb = await this.browserVm();
        const health = await sb.runCommand({ cmd: 'bash', args: ['-lc', HEALTH] });
        this.browserReady = (await health.stdout()).trim() === 'ok';
      }
      const ref = name === 'browser.press' ? '@focused' : typeof args.ref === 'string' ? args.ref : '';
      if (this.browserReady && ref) {
        const r = await this.browserAct({ action: 'describe', ref, tab: this.o.runId }).catch(() => null);
        if (r?.target) return { browserTarget: r.target };
      }
    }
    if (name === 'computer.write_file' && typeof args.path === 'string') {
      const sb = await this.computer();
      const r = await sb.runCommand({ cmd: 'test', args: ['-e', this.abs(args.path)] });
      return { fileExists: r.exitCode === 0 };
    }
    return {};
  }

  private abs(p: string) {
    if (!p) return WORKSPACE;
    if (p.startsWith('/')) return p;
    if (p.startsWith('~/')) return `${this.home}/${p.slice(2)}`;
    return `${WORKSPACE}/${p}`;
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext, resume?: ToolCallData['background']): Promise<ToolResult | { yield: true }> {
    const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
    switch (name) {
      case 'web.fetch': {
        // Stop ends it at any step, the address lookup included (W-196).
        const r = await fetchReadable(s('url'), { guard: true, maxChars: Number(args.max_chars) || 40000, signal: ctx.signal });
        return { output: r.output, isError: r.status >= 400 };
      }
      case 'github.request':
        return this.github(s('method') || 'GET', s('path'), args.body, ctx);
      case 'computer.shell':
        return this.shell(s('command'), s('cwd'), Number(args.timeout_sec) || 120, !!args.background, ctx, resume);
      case 'computer.shell_status':
        return this.jobStatus(s('job_id'), Math.min(Number(args.wait_sec) || 0, 600), ctx);
      case 'computer.read_file':
        return this.readFile(s('path'), Number(args.offset) || 1, Number(args.limit) || 400, ctx);
      case 'computer.write_file': {
        const sb = await this.computer();
        const path = this.abs(s('path'));
        await sb.runCommand({ cmd: 'mkdir', args: ['-p', path.replace(/\/[^/]*$/, '') || '/'] });
        await sb.writeFiles([{ path, content: Buffer.from(s('content')) }]);
        return { output: `Wrote ${Buffer.byteLength(s('content'))} bytes to ${path}.` };
      }
      case 'computer.edit_file': {
        const sb = await this.computer();
        const path = this.abs(s('path'));
        // Bounded before anything is decoded.
        const r = await readCapped(sb, path, EDIT_MAX, readLimits(ctx));
        if (r.status !== 'ok') return notRead(r.status, path, `${path} is larger than ${EDIT_MAX / MB} MB, too big for edit_file. Change it with the shell instead (sed, or a short script).`);
        const text = r.data.toString('utf8');
        const count = text.split(s('old_text')).length - 1;
        if (!s('old_text') || count === 0) return { output: 'old_text was not found in the file.', isError: true };
        if (count > 1) return { output: `old_text appears ${count} times; include more context so it is unique.`, isError: true };
        await sb.writeFiles([{ path, content: Buffer.from(text.replace(s('old_text'), () => s('new_text'))) }]);
        return { output: `Edited ${path}.` };
      }
      case 'computer.list_files': {
        const sb = await this.computer();
        const depth = Math.max(1, Math.min(3, Number(args.depth) || 1));
        const r = await sb.runCommand({ cmd: 'bash', args: [...WREN_SH, `find ${shq(this.abs(s('path') || WORKSPACE))} -maxdepth ${depth} -not -path '*/node_modules/*' -not -path '*/.git/*' -printf '%y %s %p\\n' 2>&1 | head -500`] });
        const listed = await commandOutput(r, 256 * 1024);
        return { output: (listed.stdout || '(empty)') + (listed.truncated ? '\n[the listing was cut short; list a smaller folder]' : '') };
      }
      case 'computer.share_file': {
        const sb = await this.computer();
        const path = this.abs(s('path'));
        // The limit holds while the file streams in, so a bigger one is never held whole.
        const r = await readCapped(sb, path, SHARE_MAX, readLimits(ctx));
        if (r.status !== 'ok') return notRead(r.status, path, `${path} is larger than ${SHARE_MAX / MB} MB, the most a shared file can be. Compress it or share a smaller part.`);
        const name = s('name') || path.split('/').pop() || 'file';
        const a = await saveArtifact({ userId: this.o.userId, agentId: this.o.agentId, sessionId: this.o.sessionId, runId: this.o.runId, name, mime: guessMime(name), data: r.data, source: 'cloud', leaseId: this.o.leaseId });
        return { output: `Shared "${a.name}" (${a.size} bytes) with the user.`, artifacts: [{ id: a.id, name: a.name }] };
      }
    }
    if (name.startsWith('browser.')) return this.browser(name.slice(8), args, ctx);
    if (name.startsWith('mcp_')) {
      const ns = name.slice(0, name.indexOf('.'));
      const server = this.o.mcp?.get(ns);
      const tool = server?.tools.find((x) => x.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) === name.slice(ns.length + 1));
      if (!server || !tool) return { output: 'That connected tool is no longer available.', isError: true };
      // Connecting can take a while: a Stop, or this tick losing the run, meanwhile means the tool isn't
      // called (W-190).
      // Over by the tick's deadline; one that starts just before it still gets 30 s, which the function's time leaves room for.
      return callMcp(server.url, server.token, tool.name, args, { signal: ctx.signal, stillWanted: () => this.stillWanted(ctx), timeoutMs: Math.max(ctx.deadline - Date.now(), 30_000) });
    }
    return { output: `Tool ${name} is not available on the cloud computer.`, isError: true };
  }

  /**
   * Whether the run still wants this tick to act: not stopped, and still this tick's. The lease is checked
   * as the store does after a write that matched nothing.
   */
  private async stillWanted(ctx: ToolContext) {
    if (ctx.signal?.aborted || (await ctx.isCancelled?.())) return false;
    if (!this.o.leaseId) return true;
    return (await db()`select 1 from public.runs where id = ${this.o.runId} and lease_id = ${this.o.leaseId}`).length > 0;
  }

  // ------------------------------------------------------------ shell

  private async shell(command: string, cwd: string, timeoutSec: number, background: boolean, ctx: ToolContext, resume?: ToolCallData['background']): Promise<ToolResult | { yield: true }> {
    const sb = await this.computer();
    let id = resume?.kind === 'job' ? resume.handle : '';
    const started = resume?.startedAt ?? Date.now();
    if (!id) {
      if (!command.trim()) return { output: 'Empty command.', isError: true };
      id = randomUUID().slice(0, 8);
      // No credentials go into the VM: GitHub access is only through the github.request tool,
      // which is risk-assessed and runs here.
      await sb.runCommand({ cmd: 'bash', args: [...WREN_SH, `setsid nohup "$HOME/.wren/run.sh" ${id} ${shq(cwd ? this.abs(cwd) : WORKSPACE)} ${shq(command)} ${shq(this.o.runId)} >/dev/null 2>&1 < /dev/null &`] });
      if (background) return { output: `Started background job ${id}. Check it with computer.shell_status.`, meta: { job: id } };
      await ctx.checkpoint({ kind: 'job', handle: id, startedAt: started });
    }
    const limit = Math.min(Math.max(timeoutSec, 5), 1800) * 1000;
    let checked = Date.now();
    for (;;) {
      const st = await this.readJob(id);
      if (st.exit !== null) return { output: formatJob(st.exit, st.log), isError: st.exit !== 0 };
      if (Date.now() - started > limit) {
        await this.stopJob(id);
        return { output: `Timed out after ${Math.round(limit / 1000)}s (job ${id} was stopped).\n${tail(st.log)}`, isError: true };
      }
      if (Date.now() - checked > 5000) {
        checked = Date.now();
        if (await ctx.isCancelled?.()) {
          await this.stopJob(id);
          return { output: `Stopped by the user (job ${id} was stopped).\n${tail(st.log)}`, isError: true };
        }
      }
      if (Date.now() > ctx.deadline - 5000) return { yield: true };
      if (!st.alive) return { output: `The command stopped unexpectedly (the computer may have restarted).\n${tail(st.log)}`, isError: true };
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  private async stopJob(id: string) {
    const sb = await this.computer();
    await sb.runCommand({ cmd: 'bash', args: [...WREN_SH, `${STOP_JOB}\nstopjob ${shq(id)}`] });
  }

  private async readJob(id: string): Promise<{ exit: number | null; log: string; alive: boolean }> {
    const sb = await this.computer();
    // Everything printed comes into this function, and the files are the agent's to write: the exit code and
    // pid are read as short numbers only, the log as its last 60 KB (W-191).
    const r = await sb.runCommand({
      cmd: 'bash',
      args: [...WREN_SH, `${JOB_NUM}\nd=${JOB_DIR}; e=$(jobnum "$d/${id}.exit"); p=$(jobnum "$d/${id}.pid"); a=0; [ -n "$p" ] && kill -0 "$p" 2>/dev/null && a=1; echo "$e|$a"; [ -f "$d/${id}.log" ] && tail -c 60000 -- "$d/${id}.log" 2>/dev/null`],
    });
    const out = (await commandOutput(r, 64 * 1024)).stdout;
    const nl = out.indexOf('\n');
    const [exit, alive] = (nl >= 0 ? out.slice(0, nl) : out).split('|');
    return { exit: /^\d+$/.test(exit ?? '') ? Number(exit) : null, alive: alive === '1', log: nl >= 0 ? out.slice(nl + 1) : '' };
  }

  private async jobStatus(id: string, waitSec: number, ctx: ToolContext): Promise<ToolResult> {
    if (!/^[a-f0-9-]{4,40}$/i.test(id)) return { output: 'Unknown job id.', isError: true };
    const until = Math.min(Date.now() + waitSec * 1000, ctx.deadline - 8000);
    let checked = Date.now();
    for (;;) {
      const st = await this.readJob(id);
      if (st.exit !== null) return { output: `Job ${id} finished.\n${formatJob(st.exit, st.log)}` };
      if (Date.now() >= until) return { output: `Job ${id} is ${st.alive ? 'still running' : 'not running (it may have been interrupted)'}.\n${tail(st.log)}` };
      if (Date.now() - checked > 5000) {
        checked = Date.now();
        if (await ctx.isCancelled?.()) return { output: 'Stopped by the user.', isError: true };
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  private async readFile(path: string, offset: number, limit: number, ctx: ToolContext): Promise<ToolResult> {
    const sb = await this.computer();
    const p = this.abs(path);
    const r = await readCapped(sb, p, READ_MAX, readLimits(ctx));
    if (r.status !== 'ok') {
      return notRead(r.status, p, `${p} is larger than ${READ_MAX / MB} MB, so it wasn't read. Read part of it with the shell instead, e.g. sed -n '1,200p' ${shq(p)}, head -c 20000 ${shq(p)} or grep -n 'text' ${shq(p)}.`);
    }
    const buf = r.data;
    if (buf.includes(0)) return { output: `${p} looks like a binary file (${buf.byteLength} bytes). Use the shell to inspect it.`, isError: true };
    const lines = buf.toString('utf8').split('\n');
    const start = Math.max(1, offset);
    const slice = lines.slice(start - 1, start - 1 + Math.min(limit, 2000));
    // Each line and the whole answer are bounded: a minified file can be one line of megabytes.
    const rows: string[] = [];
    let size = 0;
    let firstCut = 0;
    for (const [i, l] of slice.entries()) {
      let shown = l;
      if (l.length > LINE_MAX) {
        const end = isHighSurrogate(l.charCodeAt(LINE_MAX - 1)) ? LINE_MAX - 1 : LINE_MAX;
        shown = `${l.slice(0, end)} … [${l.length - end} more characters]`;
      }
      const row = `${String(start + i).padStart(5)}  ${shown}`;
      if (rows.length && size + row.length + 1 > READ_OUTPUT_MAX) break;
      rows.push(row);
      size += row.length + 1;
      if (shown !== l) firstCut ||= start + i;
    }
    const more = start - 1 + rows.length < lines.length ? `\n[lines ${start}-${start + rows.length - 1} of ${lines.length}; read more with offset]` : '';
    const cut = firstCut ? `\n[lines longer than ${LINE_MAX} characters are cut; see the rest with the shell, e.g. sed -n '${firstCut}p' ${shq(p)} | cut -c ${LINE_MAX + 1}-${LINE_MAX * 3}]` : '';
    return { output: rows.join('\n') + more + cut };
  }

  // ------------------------------------------------------------ browser

  private async ensureBrowser(deadline: number) {
    if (this.browserReady) return;
    const sb = await this.browserVm();
    const health = await sb.runCommand({ cmd: 'bash', args: ['-lc', HEALTH] });
    if ((await health.stdout()).trim() === 'ok') {
      this.browserReady = true;
      return;
    }
    // Not running, or an older daemon: (re)start the current one. ("[b]rowser" so pkill doesn't
    // match, and kill, the shell running it.)
    // The old daemon and its Chromium must be gone (port and profile free), and a profile restored
    // from a snapshot can carry a stale "in use" lock that makes Chromium quit at once.
    const prep = await sb.runCommand({ cmd: 'bash', args: ['-lc', STOP_BROWSER] });
    const home = (await prep.stdout()).trim().split('\n').pop() || '/home/ubuntu';
    await sb.writeFiles([{ path: `${home}/.wren/setup.sh`, content: Buffer.from(BROWSER_SETUP) }]);
    for (;;) {
      const st = (await (await sb.runCommand({ cmd: 'bash', args: ['-lc', BROWSER_STATE] })).stdout()).trim();
      if (st === 'ok') break;
      if (st.startsWith('failed')) throw new Error(`Could not set up the browser: ${st.slice(6).trim()}`);
      if (Date.now() > deadline - 20_000) throw new BrowserNotReady();
      await new Promise((r) => setTimeout(r, 4000));
    }
    await sb.writeFiles([
      { path: `${home}/.wren/browser.ts`, content: Buffer.from(BROWSER_DAEMON_TS) },
      { path: `${home}/.wren/browser.version`, content: Buffer.from(DAEMON_VERSION) },
    ]);
    // A detached command (never waited on): a shell that started the daemon in the background
    // would otherwise keep the command's output open, and the call hang, while the daemon runs.
    await sb.runCommand({ cmd: 'bash', args: ['-lc', 'cd "$HOME/.wren" && exec setsid node browser.ts > browser.log 2>&1 < /dev/null'], detached: true });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const h = await sb.runCommand({ cmd: 'bash', args: ['-lc', HEALTH] });
      if ((await h.stdout()).trim() === 'ok') {
        this.browserReady = true;
        return;
      }
    }
    const log = await sb.runCommand({ cmd: 'bash', args: ['-lc', 'tail -c 1500 "$HOME/.wren/browser.log"'] });
    throw new Error(`The browser did not start: ${await log.stdout()}`);
  }

  private async browserAct(action: Record<string, unknown>): Promise<{ ok: boolean; error?: string; snapshot?: string; image?: string; preview?: string; url?: string; title?: string; target?: { label: string; role: string; inputType?: string; autocomplete?: string; elementId?: string; url?: string; href?: string; form?: string } }> {
    const sb = await this.browserVm();
    const payload = Buffer.from(JSON.stringify(action)).toString('base64');
    const r = await sb.runCommand({ cmd: 'bash', args: ['-lc', `echo ${payload} | base64 -d | { ${ACT(60)}; }`] });
    const out = await r.stdout();
    try {
      return JSON.parse(out);
    } catch {
      this.browserReady = false;
      return { ok: false, error: `Browser did not respond (${out.slice(0, 200) || 'no output'}).` };
    }
  }

  private async browser(action: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      await this.ensureBrowser(ctx.deadline);
    } catch (e) {
      if (e instanceof BrowserNotReady) return { output: 'The browser is still being installed for this agent (the first time takes a few minutes). Try the browser action again in a minute.', isError: true };
      throw e;
    }
    const expect = ctx.expect;
    // `expect` is the element the approval was given for; the controller refuses if the page changed.
    const r = await this.browserAct({ ...args, action, tab: this.o.runId, ...(expect ? { expect } : {}) });
    if (r.preview && this.o.onLiveView) await this.o.onLiveView({ data: r.preview, url: r.url, title: r.title }).catch(() => {});
    const images: ImageRef[] = [];
    if (r.image) {
      const a = await saveArtifact({ userId: this.o.userId, agentId: this.o.agentId, sessionId: this.o.sessionId, runId: this.o.runId, name: `screenshot-${Date.now()}.jpg`, mime: 'image/jpeg', data: Buffer.from(r.image, 'base64'), kind: 'screenshot', leaseId: this.o.leaseId });
      this.imageCache.set(a.id, { mime: 'image/jpeg', data: r.image });
      images.push({ artifactId: a.id, mime: 'image/jpeg' });
    }
    const text = r.ok ? r.snapshot ?? (r.image ? `Screenshot of ${r.title ?? ''} (${r.url ?? ''})` : 'Done.') : `Browser error: ${r.error}\n${r.snapshot ?? ''}`;
    return { output: text, isError: !r.ok, images, meta: { url: r.url, title: r.title } };
  }

  // ------------------------------------------------------------ github

  private async github(method: string, path: string, body: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!this.o.githubToken) return { output: 'GitHub is not connected. Ask the user to connect it in Connections.', isError: true };
    if (!path.startsWith('/') || path.includes('://')) return { output: 'Path must start with / (e.g. /user/repos).', isError: true };
    assessGithub(method, path); // risk is enforced by the loop; this just validates shape
    // A Stop can come after the approval (or while this tick lost the run): look again right before sending,
    // and let the Stop's signal end a request under way (W-194).
    if (!(await this.stillWanted(ctx))) return { output: 'The GitHub request was not sent because the task was stopped.', isError: true };
    let res: Response;
    let text: string;
    try {
      res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: { authorization: `Bearer ${this.o.githubToken}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'wren-agent' },
        body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
        signal: ctx.signal,
      });
      text = await res.text();
    } catch (e) {
      if (ctx.signal?.aborted) return { output: 'The task was stopped while the GitHub request was under way; GitHub may or may not have carried it out.', isError: true };
      throw e;
    }
    let out = text;
    try {
      out = JSON.stringify(JSON.parse(text), null, 1);
    } catch {
      /* not json */
    }
    return { output: `HTTP ${res.status}\n${out.slice(0, 40000)}`, isError: res.status >= 400 };
  }
}

function shq(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * How long a file read may take: until the tick's deadline; one that starts just before it still
 * gets 30 s, which the function's time leaves room for. A Stop's signal ends it at once.
 */
function readLimits(ctx: ToolContext) {
  return { signal: ctx.signal, timeoutMs: Math.max(ctx.deadline - Date.now(), 30_000) };
}

/** The answer for a file read that didn't get the file; `tooLarge` says what to do instead. */
function notRead(status: Exclude<CappedRead['status'], 'ok'>, path: string, tooLarge: string): ToolResult {
  switch (status) {
    case 'missing':
      return { output: `File not found: ${path}`, isError: true };
    case 'too_large':
      return { output: tooLarge, isError: true };
    case 'stopped':
      return { output: `The task was stopped while reading ${path}.`, isError: true };
    case 'timed_out':
      return { output: `Reading ${path} took too long, so it was stopped. Try again, or read part of it with the shell.`, isError: true };
  }
}

function isHighSurrogate(c: number) {
  return c >= 0xd800 && c <= 0xdbff;
}

function tail(s: string, n = 6000) {
  return s.length > n ? '…' + s.slice(-n) : s;
}

function formatJob(exit: number, log: string) {
  return `exit code ${exit}\n${tail(log, 28000) || '(no output)'}`;
}
