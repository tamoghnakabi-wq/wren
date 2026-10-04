import { Sandbox } from '@vercel/sandbox';
import { createHash, randomUUID } from 'node:crypto';
import type { ImageRef, ToolCallData, ToolContext, ToolHost, ToolResult } from '@wren/core';
import { BROWSER_DAEMON_TS } from '@wren/core/browser/daemon-source';
import { fetchReadable } from '@wren/core/net';
import { assessGithub } from '@wren/core';
import { guessMime, saveArtifact } from '../blob';
import { callMcp, type McpToolInfo } from '../mcp';
import { env } from '../env';

// Tool host for cloud runs. The agent's computer is a persistent Vercel
// Sandbox (one per agent); the model loop and every credential stay in our
// functions, never inside the VM. web.fetch and github.request run here with
// guards; everything else is a command or file operation in the sandbox.

export const WORKSPACE = '/vercel/sandbox';
const JOB_DIR = '$HOME/.wren/jobs';

/** Changes whenever the daemon code does, so a stale daemon in a persistent VM gets replaced. */
const DAEMON_VERSION = createHash('sha256').update(BROWSER_DAEMON_TS).digest('hex').slice(0, 16);
const HEALTH = `[ "$(cat "$HOME/.wren/browser.version" 2>/dev/null)" = "${DAEMON_VERSION}" ] && curl -s -m 2 http://127.0.0.1:9333/health`;

const RUN_SH = `#!/bin/bash
# usage: run.sh <id> <cwd> <command>
id="$1"; cwd="$2"; cmd="$3"
dir="$HOME/.wren/jobs"; mkdir -p "$dir"
cd "$cwd" 2>/dev/null || cd ${WORKSPACE}
echo $$ > "$dir/$id.pid"
setsid bash -lc "$cmd" > "$dir/$id.log" 2>&1 < /dev/null
echo $? > "$dir/$id.exit"
`;

const BROWSER_SETUP = `set -e
mkdir -p "$HOME/.wren" && cd "$HOME/.wren"
if [ ! -d node_modules/playwright ]; then
  echo '{"type":"module","private":true}' > package.json
  npm install --silent --no-audit --no-fund playwright@1.63.0 >/dev/null 2>&1
fi
if [ ! -f .chromium-ok ]; then
  sudo -E env "PATH=$PATH" npx --yes playwright@1.63.0 install-deps chromium >/dev/null 2>&1 || true
  npx --yes playwright@1.63.0 install chromium >/dev/null 2>&1
  touch .chromium-ok
fi
`;

export interface SandboxHostOptions {
  agentId: string;
  userId: string;
  sessionId: string;
  runId: string;
  githubToken?: string;
  /** namespace -> connected MCP server */
  mcp?: Map<string, { url: string; token?: string; tools: McpToolInfo[] }>;
  onLiveView?: (preview: { data: string; url?: string; title?: string }) => Promise<void>;
}

export class SandboxHost implements ToolHost {
  readonly runtime = 'cloud' as const;
  private sandbox: Sandbox | null = null;
  private ready = false;
  private browserReady = false;
  private home = '/home/ubuntu';
  /** images produced this tick, so the next model call doesn't refetch them */
  readonly imageCache = new Map<string, { mime: string; data: string }>();

  constructor(private readonly o: SandboxHostOptions) {}

  static sandboxName(agentId: string) {
    return `wren-agent-${agentId}`;
  }

  async computer(): Promise<Sandbox> {
    if (this.sandbox && this.ready) return this.sandbox;
    this.sandbox = await Sandbox.getOrCreate({
      name: SandboxHost.sandboxName(this.o.agentId),
      image: 'vercel/sandbox/universal',
      region: env.sandboxRegion,
      timeout: 45 * 60 * 1000,
      resources: { vcpus: 2 },
      keepLastSnapshots: { count: 1, deleteEvicted: true },
      snapshotExpiration: 30 * 24 * 60 * 60 * 1000,
      tags: { app: 'wren', agent: this.o.agentId.slice(0, 32) },
    });
    // Idempotent per session: helper scripts live in $HOME/.wren.
    const setup = await this.sandbox.runCommand({
      cmd: 'bash',
      args: ['-lc', `mkdir -p ${WORKSPACE} "$HOME/.wren/jobs" && cat > "$HOME/.wren/run.sh" <<'WREN_EOF'\n${RUN_SH}WREN_EOF\nchmod +x "$HOME/.wren/run.sh" && echo "$HOME"`],
    });
    this.home = (await setup.stdout()).trim().split('\n').pop() || this.home;
    this.ready = true;
    return this.sandbox;
  }

  /** Stop the agent's computer (its filesystem is snapshotted automatically). */
  async stop() {
    try {
      const sb = this.sandbox ?? (await Sandbox.get({ name: SandboxHost.sandboxName(this.o.agentId), resume: false }));
      if (sb.status === 'running' || sb.status === 'pending') await sb.stop();
    } catch {
      // never created, already stopped, or gone
    }
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
        const sb = await this.computer();
        const health = await sb.runCommand({ cmd: 'bash', args: ['-lc', HEALTH] });
        this.browserReady = (await health.stdout()).trim() === 'ok';
      }
      const ref = name === 'browser.press' ? '@focused' : typeof args.ref === 'string' ? args.ref : '';
      if (this.browserReady && ref) {
        const r = await this.browserAct({ action: 'describe', ref }).catch(() => null);
        if (r?.target) return { browserTarget: { label: r.target.label, role: r.target.role, inputType: r.target.inputType, autocomplete: r.target.autocomplete } };
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
        const r = await fetchReadable(s('url'), { guard: true, maxChars: Number(args.max_chars) || 40000 });
        return { output: r.output, isError: r.status >= 400 };
      }
      case 'github.request':
        return this.github(s('method') || 'GET', s('path'), args.body);
      case 'computer.shell':
        return this.shell(s('command'), s('cwd'), Number(args.timeout_sec) || 120, !!args.background, ctx, resume);
      case 'computer.shell_status':
        return this.jobStatus(s('job_id'), Math.min(Number(args.wait_sec) || 0, 600), ctx);
      case 'computer.read_file':
        return this.readFile(s('path'), Number(args.offset) || 1, Number(args.limit) || 400);
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
        const buf = await sb.readFileToBuffer({ path });
        if (!buf) return { output: `File not found: ${path}`, isError: true };
        const text = buf.toString('utf8');
        const count = text.split(s('old_text')).length - 1;
        if (!s('old_text') || count === 0) return { output: 'old_text was not found in the file.', isError: true };
        if (count > 1) return { output: `old_text appears ${count} times; include more context so it is unique.`, isError: true };
        await sb.writeFiles([{ path, content: Buffer.from(text.replace(s('old_text'), () => s('new_text'))) }]);
        return { output: `Edited ${path}.` };
      }
      case 'computer.list_files': {
        const sb = await this.computer();
        const depth = Math.max(1, Math.min(3, Number(args.depth) || 1));
        const r = await sb.runCommand({ cmd: 'bash', args: ['-lc', `find ${shq(this.abs(s('path') || WORKSPACE))} -maxdepth ${depth} -not -path '*/node_modules/*' -not -path '*/.git/*' -printf '%y %s %p\\n' 2>&1 | head -500`] });
        return { output: (await r.stdout()) || '(empty)' };
      }
      case 'computer.share_file': {
        const sb = await this.computer();
        const path = this.abs(s('path'));
        const buf = await sb.readFileToBuffer({ path });
        if (!buf) return { output: `File not found: ${path}`, isError: true };
        if (buf.byteLength > 200 * 1024 * 1024) return { output: 'File is larger than 200 MB.', isError: true };
        const name = s('name') || path.split('/').pop() || 'file';
        const a = await saveArtifact({ userId: this.o.userId, agentId: this.o.agentId, sessionId: this.o.sessionId, runId: this.o.runId, name, mime: guessMime(name), data: buf, source: 'cloud' });
        return { output: `Shared "${a.name}" (${a.size} bytes) with the user.`, artifacts: [{ id: a.id, name: a.name }] };
      }
    }
    if (name.startsWith('browser.')) return this.browser(name.slice(8), args);
    if (name.startsWith('mcp_')) {
      const ns = name.slice(0, name.indexOf('.'));
      const server = this.o.mcp?.get(ns);
      const tool = server?.tools.find((x) => x.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) === name.slice(ns.length + 1));
      if (!server || !tool) return { output: 'That connected tool is no longer available.', isError: true };
      return callMcp(server.url, server.token, tool.name, args);
    }
    return { output: `Tool ${name} is not available on the cloud computer.`, isError: true };
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
      await sb.runCommand({ cmd: 'bash', args: ['-lc', `nohup "$HOME/.wren/run.sh" ${id} ${shq(cwd ? this.abs(cwd) : WORKSPACE)} ${shq(command)} >/dev/null 2>&1 &`] });
      if (background) return { output: `Started background job ${id}. Check it with computer.shell_status.`, meta: { job: id } };
      await ctx.checkpoint({ kind: 'job', handle: id, startedAt: started });
    }
    const limit = Math.min(Math.max(timeoutSec, 5), 1800) * 1000;
    for (;;) {
      const st = await this.readJob(id);
      if (st.exit !== null) return { output: formatJob(st.exit, st.log), isError: st.exit !== 0 };
      if (Date.now() - started > limit) {
        await sb.runCommand({ cmd: 'bash', args: ['-lc', `kill -- -$(cat ${JOB_DIR}/${id}.pid) 2>/dev/null; kill $(cat ${JOB_DIR}/${id}.pid) 2>/dev/null; true`] });
        return { output: `Timed out after ${Math.round(limit / 1000)}s (job ${id} was stopped).\n${tail(st.log)}`, isError: true };
      }
      if (Date.now() > ctx.deadline - 5000) return { yield: true };
      if (!st.alive) return { output: `The command stopped unexpectedly (the computer may have restarted).\n${tail(st.log)}`, isError: true };
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  private async readJob(id: string): Promise<{ exit: number | null; log: string; alive: boolean }> {
    const sb = await this.computer();
    const r = await sb.runCommand({
      cmd: 'bash',
      args: ['-lc', `d=${JOB_DIR}; e=$(cat $d/${id}.exit 2>/dev/null); p=$(cat $d/${id}.pid 2>/dev/null); a=0; [ -n "$p" ] && kill -0 $p 2>/dev/null && a=1; echo "$e|$a"; tail -c 60000 $d/${id}.log 2>/dev/null`],
    });
    const out = await r.stdout();
    const nl = out.indexOf('\n');
    const [exit, alive] = (nl >= 0 ? out.slice(0, nl) : out).split('|');
    return { exit: exit === '' || exit === undefined ? null : Number(exit), alive: alive === '1', log: nl >= 0 ? out.slice(nl + 1) : '' };
  }

  private async jobStatus(id: string, waitSec: number, ctx: ToolContext): Promise<ToolResult> {
    if (!/^[a-f0-9-]{4,40}$/i.test(id)) return { output: 'Unknown job id.', isError: true };
    const until = Math.min(Date.now() + waitSec * 1000, ctx.deadline - 8000);
    for (;;) {
      const st = await this.readJob(id);
      if (st.exit !== null) return { output: `Job ${id} finished.\n${formatJob(st.exit, st.log)}` };
      if (Date.now() >= until) return { output: `Job ${id} is ${st.alive ? 'still running' : 'not running (it may have been interrupted)'}.\n${tail(st.log)}` };
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  private async readFile(path: string, offset: number, limit: number): Promise<ToolResult> {
    const sb = await this.computer();
    const p = this.abs(path);
    const buf = await sb.readFileToBuffer({ path: p });
    if (!buf) return { output: `File not found: ${p}`, isError: true };
    if (buf.includes(0)) return { output: `${p} looks like a binary file (${buf.byteLength} bytes). Use the shell to inspect it.`, isError: true };
    const lines = buf.toString('utf8').split('\n');
    const start = Math.max(1, offset);
    const slice = lines.slice(start - 1, start - 1 + Math.min(limit, 2000));
    const more = start - 1 + slice.length < lines.length ? `\n[lines ${start}-${start + slice.length - 1} of ${lines.length}; read more with offset]` : '';
    return { output: slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n') + more };
  }

  // ------------------------------------------------------------ browser

  private async ensureBrowser() {
    if (this.browserReady) return;
    const sb = await this.computer();
    const health = await sb.runCommand({ cmd: 'bash', args: ['-lc', HEALTH] });
    if ((await health.stdout()).trim() === 'ok') {
      this.browserReady = true;
      return;
    }
    // Not running, or an older daemon: (re)start the current one.
    await sb.runCommand({ cmd: 'bash', args: ['-lc', 'pkill -f "node browser.ts" 2>/dev/null; sleep 0.5; true'] });
    const setup = await sb.runCommand({ cmd: 'bash', args: ['-lc', BROWSER_SETUP] });
    if (setup.exitCode !== 0) throw new Error(`Could not set up the browser: ${(await setup.output('both')).slice(-800)}`);
    await sb.writeFiles([
      { path: `${this.home}/.wren/browser.ts`, content: Buffer.from(BROWSER_DAEMON_TS) },
      { path: `${this.home}/.wren/browser.version`, content: Buffer.from(DAEMON_VERSION) },
    ]);
    await sb.runCommand({ cmd: 'bash', args: ['-lc', 'cd "$HOME/.wren" && nohup node browser.ts > browser.log 2>&1 &'] });
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

  private async browserAct(action: Record<string, unknown>): Promise<{ ok: boolean; error?: string; snapshot?: string; image?: string; preview?: string; url?: string; title?: string; target?: { label: string; role: string; inputType?: string; autocomplete?: string } }> {
    const sb = await this.computer();
    const payload = Buffer.from(JSON.stringify(action)).toString('base64');
    const r = await sb.runCommand({ cmd: 'bash', args: ['-lc', `echo ${payload} | base64 -d | curl -s -m 60 -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:9333/act`] });
    const out = await r.stdout();
    try {
      return JSON.parse(out);
    } catch {
      this.browserReady = false;
      return { ok: false, error: `Browser did not respond (${out.slice(0, 200) || 'no output'}).` };
    }
  }

  private async browser(action: string, args: Record<string, unknown>): Promise<ToolResult> {
    await this.ensureBrowser();
    const r = await this.browserAct({ ...args, action });
    if (r.preview && this.o.onLiveView) await this.o.onLiveView({ data: r.preview, url: r.url, title: r.title }).catch(() => {});
    const images: ImageRef[] = [];
    if (r.image) {
      const a = await saveArtifact({ userId: this.o.userId, agentId: this.o.agentId, sessionId: this.o.sessionId, runId: this.o.runId, name: `screenshot-${Date.now()}.jpg`, mime: 'image/jpeg', data: Buffer.from(r.image, 'base64'), kind: 'screenshot' });
      this.imageCache.set(a.id, { mime: 'image/jpeg', data: r.image });
      images.push({ artifactId: a.id, mime: 'image/jpeg' });
    }
    const text = r.ok ? r.snapshot ?? (r.image ? `Screenshot of ${r.title ?? ''} (${r.url ?? ''})` : 'Done.') : `Browser error: ${r.error}\n${r.snapshot ?? ''}`;
    return { output: text, isError: !r.ok, images, meta: { url: r.url, title: r.title } };
  }

  // ------------------------------------------------------------ github

  private async github(method: string, path: string, body: unknown): Promise<ToolResult> {
    if (!this.o.githubToken) return { output: 'GitHub is not connected. Ask the user to connect it in Connections.', isError: true };
    if (!path.startsWith('/') || path.includes('://')) return { output: 'Path must start with / (e.g. /user/repos).', isError: true };
    assessGithub(method, path); // risk is enforced by the loop; this just validates shape
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${this.o.githubToken}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'wren-agent' },
      body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
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

function tail(s: string, n = 6000) {
  return s.length > n ? '…' + s.slice(-n) : s;
}

function formatJob(exit: number, log: string) {
  return `exit code ${exit}\n${tail(log, 28000) || '(no output)'}`;
}
