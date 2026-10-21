import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolResult } from '@wren/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The cloud host reads a shell job's state with one command in the VM, and the SDK collects everything that
// command prints into the function (W-191). The job's files are the agent's to write, so a huge one must not
// come in whole. The stand-in runs the host's real command with bash here, in a temporary home, and counts
// what it printed.

const MB = 1024 * 1024;
const ID = 'abcd1234';
let home = '';
const printed: number[] = [];

const box = {
  async runCommand(o: { cmd: string; args: string[] }) {
    const script = o.args[o.args.indexOf('-c') + 1] ?? o.args[1] ?? '';
    // Wren's own commands there read no login or startup files (W-191).
    expect(o.args.slice(0, 3)).toEqual(['--noprofile', '--norc', '-c']);
    // The host's one-time setup (it writes run.sh and stops an old browser) isn't run here.
    if (script.includes('run.sh')) return { exitCode: 0, stdout: async () => `${home}\n`, logs: async function* () { yield { stream: 'stdout', data: `${home}\n` }; } };
    const out = await new Promise<Buffer>((resolve) =>
      execFile('bash', ['-c', script], { env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test' }, cwd: home, encoding: 'buffer', maxBuffer: 512 * MB, timeout: 5000 }, (_e, stdout) => resolve(stdout ?? Buffer.alloc(0))),
    );
    printed.push(out.byteLength);
    return {
      exitCode: 0,
      stdout: async () => out.toString('utf8'),
      // As the SDK streams it: in pieces, so a reader can stop early.
      logs: async function* () {
        for (let i = 0; i < out.byteLength; i += 64 * 1024) yield { stream: 'stdout', data: out.subarray(i, i + 64 * 1024).toString('utf8') };
      },
    };
  },
};
vi.mock('@vercel/sandbox', () => ({ Sandbox: { getOrCreate: async () => box } }));
vi.mock('../src/lib/db', () => ({ db: () => () => Promise.resolve([{ x: 1 }]) })); // the agent still exists
vi.mock('../src/lib/cleanup', () => ({ cleanUp: async () => {} }));
vi.mock('../src/lib/blob', () => ({ guessMime: () => 'application/octet-stream', saveArtifact: async () => ({}) }));
vi.mock('../src/lib/env', () => ({ env: {} }));
vi.mock('../src/lib/mcp', () => ({ callMcp: async () => ({ output: '' }) }));
vi.mock('@wren/core/net', () => ({ fetchReadable: async () => ({ output: '', status: 200 }) }));

const { SandboxHost } = await import('../src/lib/runner/sandbox-host');

const status = () =>
  new SandboxHost({ agentId: 'a', userId: 'u', sessionId: 's', runId: 'r' }).execute('computer.shell_status', { job_id: ID }, { runtime: 'cloud', deadline: Date.now() + 200_000, callId: 'c', checkpoint: async () => {}, isCancelled: async () => false }) as Promise<ToolResult>;
const jobFile = (ext: string, content: string | Buffer) => writeFileSync(join(home, '.wren/jobs', `${ID}.${ext}`), content);
const run = (cmd: string, args: string[]) => new Promise<void>((r) => execFile(cmd, args, () => r()));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wren-jobs-'));
  mkdirSync(join(home, '.wren/jobs'), { recursive: true });
  printed.length = 0;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("shell_status reads a job's files bounded (W-191)", () => {
  it('a huge exit file is not pulled in, and is not taken for an exit code', async () => {
    jobFile('exit', Buffer.alloc(16 * MB, '7'));
    jobFile('log', 'building\n');
    const r = await status();
    expect({ printed: printed.at(-1)! < 1000 }).toEqual({ printed: true }); // the old command printed all 16 MB
    expect(r).toEqual({ output: `Job ${ID} is not running (it may have been interrupted).\nbuilding\n` });
  });

  it('a huge pid file is not pulled in either', async () => {
    jobFile('pid', Buffer.alloc(16 * MB, '1'));
    jobFile('log', 'x\n');
    const r = await status();
    expect(printed.at(-1)! < 1000).toBe(true);
    expect(r.output).toBe(`Job ${ID} is not running (it may have been interrupted).\nx\n`);
  });

  it('only a plain number counts as an exit code, and a pipe is not waited on', async () => {
    jobFile('exit', '0; echo pwned\n');
    expect((await status()).output).toBe(`Job ${ID} is not running (it may have been interrupted).\n`);
    rmSync(join(home, '.wren/jobs', `${ID}.exit`));
    await run('mkfifo', [join(home, '.wren/jobs', `${ID}.exit`)]);
    const started = Date.now();
    expect((await status()).output).toBe(`Job ${ID} is not running (it may have been interrupted).\n`);
    expect(Date.now() - started).toBeLessThan(4000); // reading a pipe with no writer would hang
  });

  it("the log comes in as its last 60 KB, and a finished job reads as before", async () => {
    jobFile('exit', '3\n');
    jobFile('log', Buffer.concat([Buffer.alloc(5 * MB, 'a'), Buffer.from('\nthe end\n')]));
    const r = await status();
    expect(printed.at(-1)! <= 60_000 + 100).toBe(true);
    expect(r.output.startsWith(`Job ${ID} finished.\nexit code 3\n…`)).toBe(true);
    expect(r.output.endsWith('a\nthe end\n')).toBe(true);

    jobFile('exit', '0\n');
    jobFile('log', 'hello\n');
    expect(await status()).toEqual({ output: `Job ${ID} finished.\nexit code 0\nhello\n` });
  });

  it('a running job is seen as running', async () => {
    jobFile('pid', `${process.pid}\n`); // a process that is alive
    jobFile('log', 'working\n');
    expect(await status()).toEqual({ output: `Job ${ID} is still running.\nworking\n` });
  });
});
