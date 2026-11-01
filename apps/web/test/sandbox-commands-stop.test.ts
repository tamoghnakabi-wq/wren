import { Readable } from 'node:stream';
import type { ToolCallData, ToolResult } from '@wren/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wren's own commands in the agent's computer (W-191). The agent has sudo there and can replace any program,
// bash and tail included, so each command is run detached and its output read only through the capped log
// stream: a command the SDK waits for collects everything it prints in this function first. During a tool each
// also gets the task's signal (a Stop, or this tick losing the run) and a time limit, so a request or log stream
// that stalls can't hold the tool; the clean-up that must still run after a Stop gets a time limit but not the
// task's signal. The stand-in records what each call was given, refuses a waited-for command in the agent's
// computer, and can hold a finished command's log stream (as Codex did with shell_status), send output without
// end, or never answer the wait.

const ID = 'abcd1234';
type Call = { kind: string; detached?: boolean; signal?: AbortSignal; timeoutMs?: number };
const calls: Call[] = [];
const killed: string[] = [];
/** What reading the job's files prints: exit code (empty while running) and whether its pid is alive. */
const job = { exit: '0', alive: '0', log: 'hello\n' };
const mode = {
  /** While set, a job read's log stream sends nothing until it settles, and doesn't notice its signal. */
  hold: null as Promise<void> | null,
  /** The command of this kind prints without end (a program the agent replaced). */
  flood: '' as string,
  /** The VM never answers the wait for a command of this kind (until the wait's signal aborts). */
  noAnswer: '' as string,
};
let flooded = 0;

function kindOf(o: { cmd: string; args?: string[] }) {
  const all = [o.cmd, ...(o.args ?? [])].join(' ');
  if (all.includes('WREN_EOF')) return 'setup';
  if (all.includes('setsid nohup')) return 'launch';
  if (all.includes('exit $left')) return 'stop-run';
  if (all.includes(`stopjob '${ID}'`)) return 'stop-job';
  if (all.includes('tail -c 60000')) return 'read-job';
  if (o.cmd === 'mkdir') return 'mkdir';
  if (o.cmd === 'test') return 'exists';
  if (all.includes('find ')) return 'list';
  return 'other';
}

const aborted = (signal?: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const computer = {
  status: 'running',
  async runCommand(o: { cmd: string; args?: string[]; detached?: boolean; signal?: AbortSignal; timeoutMs?: number }) {
    const kind = kindOf(o);
    calls.push({ kind, detached: o.detached, signal: o.signal, timeoutMs: o.timeoutMs });
    // What the real SDK does with a command it waits for: every line goes into strings here, before anyone reads.
    if (!o.detached) throw new Error(`${kind} was run waited-for: the SDK would collect all of its output`);
    const out = kind === 'setup' ? '/vercel\n' : kind === 'read-job' ? `${job.exit}|${job.alive}\n${job.log}` : kind === 'list' ? 'f 3 /vercel/sandbox/a.txt\n' : '';
    const held = kind === 'read-job' ? mode.hold : null;
    let over = false;
    return {
      logs: () =>
        (async function* () {
          if (held) await held;
          if (mode.flood === kind) {
            while (!over) {
              flooded += 64 * 1024;
              yield { stream: 'stdout', data: 'x'.repeat(64 * 1024) };
            }
            return;
          }
          if (out) yield { stream: 'stdout', data: out };
        })(),
      async wait(w?: { signal?: AbortSignal }) {
        if (mode.noAnswer === kind || (mode.flood === kind && !over)) await aborted(w?.signal);
        return { exitCode: over ? 137 : 0 };
      },
      async kill() {
        over = true;
        killed.push(kind);
      },
    };
  },
  async writeFiles(_files: { path: string; content: Buffer }[], opts?: { signal?: AbortSignal }) {
    calls.push({ kind: 'write', signal: opts?.signal });
  },
  async readFile() {
    return Readable.from([Buffer.from('one\ntwo\n')]);
  },
};
// The browser VM is Wren's alone (agents can't reach it), so its commands are as before.
const browser = {
  status: 'running',
  async runCommand(o: { signal?: AbortSignal; timeoutMs?: number }) {
    calls.push({ kind: 'browser-close', detached: false, signal: o.signal, timeoutMs: o.timeoutMs });
    return { exitCode: 0, stdout: async () => '' };
  },
};

vi.mock('@vercel/sandbox', () => ({
  Sandbox: { getOrCreate: async () => computer, get: async (o: { name: string }) => (o.name.startsWith('wren-browser-') ? browser : computer) },
}));
vi.mock('../src/lib/db', () => ({ db: () => () => Promise.resolve([{ x: 1 }]) })); // the agent still exists
vi.mock('../src/lib/cleanup', () => ({ cleanUp: async () => {} }));
vi.mock('../src/lib/blob', () => ({ guessMime: () => 'application/octet-stream', saveArtifact: async () => ({}) }));
vi.mock('../src/lib/env', () => ({ env: {} }));
vi.mock('../src/lib/mcp', () => ({ callMcp: async () => ({ output: '' }) }));
vi.mock('@wren/core/net', () => ({ fetchReadable: async () => ({ output: '', status: 200 }) }));

const { SandboxHost } = await import('../src/lib/runner/sandbox-host');

const ctx = (signal?: AbortSignal) => ({ runtime: 'cloud' as const, deadline: Date.now() + 200_000, callId: 'c', checkpoint: async () => {}, isCancelled: async () => false, signal });
const host = () => new SandboxHost({ agentId: 'a', userId: 'u', sessionId: 's', runId: 'r' });
const run = (tool: string, args: Record<string, unknown>, c = ctx(), resume?: ToolCallData['background']) => host().execute(`computer.${tool}`, args, c, resume) as Promise<ToolResult>;

async function until(ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setImmediate(r));
  expect(ready()).toBe(true);
}
/** How a call settled within `ms`: its result, the name of the error it failed with, or still going. */
const within = (p: Promise<unknown>, ms = 1000) =>
  Promise.race([p.then((r) => ({ resolved: r }), (e: Error) => ({ failed: e.name })), new Promise((r) => setTimeout(() => r('still going'), ms))]);

beforeEach(() => {
  calls.length = 0;
  killed.length = 0;
  flooded = 0;
  Object.assign(job, { exit: '0', alive: '0', log: 'hello\n' });
  Object.assign(mode, { hold: null, flood: '', noAnswer: '' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Wren's own commands in the agent's computer are bounded (W-191)", () => {
  it('a job read that prints without end is read up to its cap, then killed', async () => {
    mode.flood = 'read-job';
    const r = (await within(run('shell_status', { job_id: ID }), 3000)) as { resolved?: ToolResult };
    expect(r.resolved?.output).toMatch(/^Job abcd1234 is not running/);
    expect(killed).toEqual(['read-job']);
    // 64 KB is the read's cap; the stream is closed as soon as it is passed.
    expect(flooded).toBeLessThanOrEqual(64 * 1024 + 64 * 1024);
  });

  it('a listing that prints without end is cut short the same way', async () => {
    mode.flood = 'list';
    const r = (await within(run('list_files', { path: '.' }), 3000)) as { resolved?: ToolResult };
    expect(r.resolved?.output).toMatch(/\[the listing was cut short; list a smaller folder\]$/);
    expect(killed).toEqual(['list']);
    expect(flooded).toBeLessThanOrEqual(256 * 1024 + 64 * 1024);
  });

  it("shell_status ends at once when the task's signal aborts while a finished command's log stream is held", async () => {
    mode.hold = new Promise(() => {}); // never let go
    const task = new AbortController();
    const status = run('shell_status', { job_id: ID }, ctx(task.signal));
    await until(() => calls.some((c) => c.kind === 'read-job'));
    task.abort();
    expect(await within(status)).toEqual({ failed: 'AbortError' });
    expect(killed).toEqual(['read-job']);
  });

  it("shell stops waiting when the task's signal aborts (a lost lease), and leaves the job running", async () => {
    Object.assign(job, { exit: '', alive: '1', log: 'working\n' });
    const task = new AbortController();
    const shell = run('shell', { command: 'sleep 100' }, ctx(task.signal));
    await until(() => calls.some((c) => c.kind === 'read-job'));
    task.abort();
    const r = (await within(shell, 3000)) as { resolved?: ToolResult };
    expect(r.resolved?.isError).toBe(true);
    expect(r.resolved?.output).toMatch(/^The task was stopped while waiting for job [a-f0-9]{8}\.$/);
    // Stopping it is for the run's clean-up after a Stop, or the worker that holds the run now.
    expect(calls.map((c) => c.kind)).not.toContain('stop-job');
  });

  it("each one during a tool is detached and gets the task's signal and a time limit", async () => {
    const task = new AbortController();
    const c = ctx(task.signal);
    const h = host();
    const exec = (tool: string, args: Record<string, unknown>) => h.execute(`computer.${tool}`, args, c) as Promise<ToolResult>;
    expect((await exec('shell', { command: 'echo hello' })).output).toBe('exit code 0\nhello\n');
    expect((await exec('shell', { command: 'npm run dev', background: true })).output).toMatch(/^Started background job/);
    expect((await exec('shell_status', { job_id: ID })).output).toBe(`Job ${ID} finished.\nexit code 0\nhello\n`);
    expect(await exec('write_file', { path: 'notes.txt', content: 'hi' })).toEqual({ output: 'Wrote 2 bytes to /vercel/sandbox/notes.txt.' });
    expect(await exec('edit_file', { path: 'notes.txt', old_text: 'two', new_text: '2' })).toEqual({ output: 'Edited /vercel/sandbox/notes.txt.' });
    expect((await exec('list_files', { path: '.' })).output).toBe('f 3 /vercel/sandbox/a.txt\n');
    expect(await h.riskContext('computer.write_file', { path: 'notes.txt' })).toEqual({ fileExists: true });

    const own = calls.filter((x) => x.kind !== 'setup' && x.kind !== 'exists');
    expect(own.map((x) => x.kind)).toEqual(['launch', 'read-job', 'launch', 'read-job', 'mkdir', 'write', 'write', 'list']);
    for (const x of own) {
      expect(x.signal, x.kind).toBeInstanceOf(AbortSignal);
      expect(x.signal!.aborted, x.kind).toBe(false);
      if (x.kind === 'write') continue; // writeFiles takes a signal only
      expect(x.detached, x.kind).toBe(true);
      // The launcher's job must outlive it, so only Wren's own wait for it is limited.
      expect(x.timeoutMs, x.kind).toBe(x.kind === 'launch' ? undefined : 30_000);
    }
    task.abort(); // a Stop now ends any of them still under way
    expect(own.filter((x) => !x.signal!.aborted).map((x) => x.kind)).toEqual([]);
    // The VM's one-time setup and the approval check's look at the file are not the task's, but are bounded too.
    const others = calls.filter((x) => x.kind === 'setup' || x.kind === 'exists');
    expect(others.map((x) => [x.kind, x.detached, x.timeoutMs, x.signal?.aborted])).toEqual([
      ['setup', true, 60_000, false],
      ['exists', true, 30_000, false],
    ]);
  });

  it("clean-up still runs without the task's signal, but within a time limit: stopping a job, and the end of a run", async () => {
    Object.assign(job, { exit: '', alive: '1', log: 'working\n' });
    const task = new AbortController();
    // A foreground job past its time limit is stopped.
    const r = await run('shell', { command: 'sleep 100', timeout_sec: 5 }, ctx(task.signal), { kind: 'job', handle: ID, startedAt: Date.now() - 60_000 });
    expect(r).toEqual({ output: `Timed out after 5s (job ${ID} was stopped).\nworking\n`, isError: true });
    task.abort();
    const stop = calls.find((x) => x.kind === 'stop-job');
    expect([stop?.detached, stop?.timeoutMs, stop?.signal?.aborted]).toEqual([true, 60_000, false]);

    calls.length = 0;
    expect(await SandboxHost.endRun('a', 'r')).toBe(true);
    expect(calls.map((x) => [x.kind, x.detached, x.timeoutMs, x.signal?.aborted])).toEqual([
      ['stop-run', true, 60_000, false],
      ['browser-close', false, undefined, undefined],
    ]);
  });

  it('a clean-up the VM never answers gives up after its time limit instead of hanging', async () => {
    vi.useFakeTimers();
    // AbortSignal.timeout runs on Node's own timers; put it on the fake clock.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
      return c.signal;
    });
    mode.noAnswer = 'stop-run';
    const ending = within(SandboxHost.endRun('a', 'r'), 120_000);
    await vi.advanceTimersByTimeAsync(64_000);
    expect(killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await ending).toEqual({ resolved: false }); // retried later by the cron
    expect(killed).toEqual(['stop-run']);
  });
});
