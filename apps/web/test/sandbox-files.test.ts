import { Readable } from 'node:stream';
import type { ToolResult } from '@wren/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The cloud computer's file tools against a Vercel Sandbox stand-in (W-191). Its readFile streams
// a file of any size in 64 KB chunks, only as fast as they are taken, and counts what it handed
// out; readFileToBuffer collects the whole stream into one buffer, as the SDK's does.

const MB = 1024 * 1024;
const CHUNK = 64 * 1024;

class FileStream extends Readable {
  produced = 0;
  private readonly size: number;
  private readonly bytes: (from: number, n: number) => Buffer;
  private readonly stallAt: number;
  constructor(size: number, bytes: (from: number, n: number) => Buffer, stallAt = Infinity) {
    super({ highWaterMark: 0 });
    this.size = size;
    this.bytes = bytes;
    this.stallAt = stallAt;
  }
  _read() {
    if (this.produced >= this.stallAt) return; // a transfer that hangs: nothing more until it's closed
    const n = Math.min(CHUNK, this.size - this.produced);
    if (n <= 0) {
      this.push(null);
      return;
    }
    const b = this.bytes(this.produced, n);
    this.produced += n;
    this.push(b);
  }
}

const box = {
  files: new Map<string, () => FileStream>(),
  opened: [] as { path: string; stream: FileStream | null; signal?: AbortSignal }[],
  written: [] as { path: string; content: Buffer }[],
  /** While set, readFile waits for it before answering (a request that hangs and ignores its signal). */
  gate: null as Promise<void> | null,
  async readFile(file: { path: string }, opts?: { signal?: AbortSignal }) {
    const make = box.files.get(file.path);
    const entry = { path: file.path, stream: make ? make() : null, signal: opts?.signal };
    box.opened.push(entry);
    await box.gate;
    return entry.stream;
  },
  async readFileToBuffer(file: { path: string }, opts?: { signal?: AbortSignal }) {
    const s = await box.readFile(file, opts);
    if (!s) return null;
    const chunks: Buffer[] = [];
    for await (const c of s) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  },
  async runCommand() {
    return { exitCode: 0, stdout: async () => '/vercel\n' };
  },
  async writeFiles(files: { path: string; content: Buffer }[]) {
    box.written.push(...files);
  },
};
const shared: { name: string; data: Buffer }[] = [];

vi.mock('@vercel/sandbox', () => ({ Sandbox: { getOrCreate: async () => box } }));
vi.mock('../src/lib/db', () => ({ db: () => () => Promise.resolve([{ x: 1 }]) })); // the agent still exists
vi.mock('../src/lib/cleanup', () => ({ cleanUp: async () => {} }));
vi.mock('../src/lib/blob', () => ({
  guessMime: () => 'application/octet-stream',
  saveArtifact: async (a: { name: string; data: Buffer; mime: string }) => {
    shared.push(a);
    return { id: 'f1', name: a.name, size: a.data.byteLength, mime: a.mime };
  },
}));
vi.mock('../src/lib/env', () => ({ env: {} }));
vi.mock('../src/lib/mcp', () => ({ callMcp: async () => ({ output: '' }) }));
vi.mock('@wren/core/net', () => ({ fetchReadable: async () => ({ output: '', status: 200 }) }));

const { SandboxHost } = await import('../src/lib/runner/sandbox-host');

const ctx = (over: { signal?: AbortSignal; deadline?: number } = {}) => ({
  runtime: 'cloud' as const,
  deadline: Date.now() + 200_000,
  callId: 'c',
  checkpoint: async () => {},
  isCancelled: async () => false,
  ...over,
});
const run = (tool: string, args: Record<string, unknown>, c = ctx()) =>
  new SandboxHost({ agentId: 'a', userId: 'u', sessionId: 's', runId: 'r' }).execute(`computer.${tool}`, args, c) as Promise<ToolResult>;

const textFile = (name: string, text: string) => {
  const buf = Buffer.from(text);
  box.files.set(`/vercel/sandbox/${name}`, () => new FileStream(buf.byteLength, (from, n) => buf.subarray(from, from + n)));
};
const bigFile = (name: string, size: number, o: { fill?: string; stallAt?: number } = {}) => {
  const fill = Buffer.alloc(CHUNK, o.fill ?? 'a');
  box.files.set(`/vercel/sandbox/${name}`, () => new FileStream(size, (_, n) => fill.subarray(0, n), o.stallAt));
};
const lastStream = () => box.opened.at(-1)?.stream as FileStream;

/** Let pending work run until `ready()` (setImmediate, so it works with fake timeouts too). */
async function until(ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setImmediate(r));
  expect(ready()).toBe(true);
}
const within = <T>(p: Promise<T>, ms = 1000) => Promise.race([p, new Promise<'still reading'>((r) => setTimeout(() => r('still reading'), ms))]);

beforeEach(() => {
  box.files.clear();
  box.opened = [];
  box.written = [];
  box.gate = null;
  shared.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('the cloud file tools read no more than they allow (W-191)', () => {
  it('read_file stops a file over 8 MB as soon as the limit is passed and closes it', async () => {
    bigFile('big.log', 40 * MB);
    const r = await run('read_file', { path: 'big.log' });
    const s = lastStream();
    // Small values only: the old code returned all 40 MB as the answer.
    expect({ read: s.produced, upToLimit: s.produced <= 8 * MB + 2 * CHUNK, closed: s.destroyed, requestEnded: box.opened[0].signal?.aborted }).toMatchObject({
      upToLimit: true,
      closed: true,
      requestEnded: true,
    });
    expect(r.isError).toBe(true);
    expect(r.output.slice(0, 1000)).toBe(
      "/vercel/sandbox/big.log is larger than 8 MB, so it wasn't read. Read part of it with the shell instead, e.g. sed -n '1,200p' '/vercel/sandbox/big.log', head -c 20000 '/vercel/sandbox/big.log' or grep -n 'text' '/vercel/sandbox/big.log'.",
    );
  });

  it('read_file shows a bounded part of a file that is one huge line', async () => {
    bigFile('app.min.js', 6 * MB); // under the limit, all on line 1
    const r = await run('read_file', { path: 'app.min.js' });
    expect(r.output.length).toBeLessThan(2300);
    expect(r.output.slice(0, 7)).toBe('    1  ');
    expect(r.output.slice(0, 2300)).toContain(`${'a'.repeat(20)} … [${6 * MB - 2000} more characters]`);
    expect(r.output.slice(0, 2300)).toContain("[lines longer than 2000 characters are cut; see the rest with the shell, e.g. sed -n '1p' '/vercel/sandbox/app.min.js' | cut -c 2001-6000]");
  });

  it("read_file's answer stays within the loop's limit and says where to go on", async () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `${i + 1}:`.padEnd(1500, 'x'));
    textFile('wide.txt', lines.join('\n'));
    const r = await run('read_file', { path: 'wide.txt', limit: 2000 });
    expect(r.output.length).toBeLessThanOrEqual(30_000);
    const shown = /\n\[lines 1-(\d+) of 1000; read more with offset\]$/.exec(r.output.slice(-200));
    expect(shown).not.toBeNull();
    const last = Number(shown![1]);
    expect(r.output.split('\n')).toHaveLength(last + 1);
    expect(r.output.split('\n')[last - 1]).toBe(`${String(last).padStart(5)}  ${lines[last - 1]}`);
    // Reading on from there starts at the next line.
    const next = await run('read_file', { path: 'wide.txt', offset: last + 1, limit: 1 });
    expect(next.output.split('\n')[0]).toBe(`${String(last + 1).padStart(5)}  ${lines[last]}`);
  });

  it('share_file refuses a file over 50 MB without holding it whole', async () => {
    bigFile('dump.bin', 80 * MB);
    const r = await run('share_file', { path: 'dump.bin' });
    const s = lastStream();
    expect({ read: s.produced, upToLimit: s.produced <= 50 * MB + 2 * CHUNK, closed: s.destroyed, uploads: shared.length }).toMatchObject({
      upToLimit: true,
      closed: true,
      uploads: 0,
    });
    expect(r).toEqual({ output: '/vercel/sandbox/dump.bin is larger than 50 MB, the most a shared file can be. Compress it or share a smaller part.', isError: true });
  });

  it('share_file shares files up to 50 MB as they are', async () => {
    textFile('report.md', '# Report\n');
    expect(await run('share_file', { path: 'report.md' })).toEqual({ output: 'Shared "report.md" (9 bytes) with the user.', artifacts: [{ id: 'f1', name: 'report.md' }] });
    expect(shared[0].data.toString()).toBe('# Report\n');

    bigFile('exact.bin', 50 * MB);
    const r = await run('share_file', { path: 'exact.bin', name: 'Exact' });
    expect(r.output).toBe(`Shared "Exact" (${50 * MB} bytes) with the user.`);
    expect(shared[1].data.byteLength).toBe(50 * MB);
  });

  it('edit_file refuses a file over 5 MB before decoding it', async () => {
    bigFile('data.csv', 6 * MB);
    const r = await run('edit_file', { path: 'data.csv', old_text: 'a', new_text: 'b' });
    const s = lastStream();
    expect({ read: s.produced, upToLimit: s.produced <= 5 * MB + 2 * CHUNK, closed: s.destroyed, writes: box.written.length }).toMatchObject({
      upToLimit: true,
      closed: true,
      writes: 0,
    });
    expect(r).toEqual({ output: '/vercel/sandbox/data.csv is larger than 5 MB, too big for edit_file. Change it with the shell instead (sed, or a short script).', isError: true });
  });

  it('a Stop ends a read under way, and one whose request has not answered yet', async () => {
    bigFile('slow.log', 4 * MB, { stallAt: MB });
    let stop = new AbortController();
    let p = run('read_file', { path: 'slow.log' }, ctx({ signal: stop.signal }));
    await until(() => (lastStream()?.produced ?? 0) >= MB);
    stop.abort();
    expect(await within(p)).toEqual({ output: 'The task was stopped while reading /vercel/sandbox/slow.log.', isError: true });
    expect(lastStream().destroyed).toBe(true);
    expect(box.opened[0].signal?.aborted).toBe(true);

    // The request itself hangs (and ignores its signal): the Stop still ends the read, and a
    // stream that arrives afterwards is closed at once.
    let release = () => {};
    box.gate = new Promise((r) => (release = r));
    stop = new AbortController();
    p = run('read_file', { path: 'slow.log' }, ctx({ signal: stop.signal }));
    await until(() => box.opened.length === 2);
    stop.abort();
    expect(await within(p)).toEqual({ output: 'The task was stopped while reading /vercel/sandbox/slow.log.', isError: true });
    release();
    await until(() => lastStream().destroyed);
    expect(lastStream().produced).toBe(0);
  });

  it("a read still going at the tick's deadline is ended (30 s at the least)", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bigFile('stuck.bin', 4 * MB, { stallAt: MB });
    let settled: ToolResult | undefined;
    void run('share_file', { path: 'stuck.bin' }, ctx({ deadline: Date.now() + 1000 })).then((r) => (settled = r));
    await until(() => (lastStream()?.produced ?? 0) >= MB);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_500);
    await until(() => settled !== undefined);
    expect(settled).toEqual({ output: 'Reading /vercel/sandbox/stuck.bin took too long, so it was stopped. Try again, or read part of it with the shell.', isError: true });
    expect(lastStream().destroyed).toBe(true);
    expect(shared).toHaveLength(0);
  });

  it('small files read, edit and share as before', async () => {
    textFile('notes.txt', 'one\ntwo\nthree\n');
    expect(await run('read_file', { path: 'notes.txt' })).toEqual({ output: '    1  one\n    2  two\n    3  three\n    4  ' });
    expect(await run('read_file', { path: 'notes.txt', offset: 2, limit: 1 })).toEqual({ output: '    2  two\n[lines 2-2 of 4; read more with offset]' });
    expect(await run('read_file', { path: 'nope.txt' })).toEqual({ output: 'File not found: /vercel/sandbox/nope.txt', isError: true });
    textFile('a.bin', 'ab\0cd');
    expect(await run('read_file', { path: 'a.bin' })).toEqual({ output: '/vercel/sandbox/a.bin looks like a binary file (5 bytes). Use the shell to inspect it.', isError: true });

    expect(await run('edit_file', { path: 'notes.txt', old_text: 'two', new_text: '2' })).toEqual({ output: 'Edited /vercel/sandbox/notes.txt.' });
    expect(box.written.map((f) => [f.path, f.content.toString()])).toEqual([['/vercel/sandbox/notes.txt', 'one\n2\nthree\n']]);
    expect(await run('edit_file', { path: 'nope.txt', old_text: 'a', new_text: 'b' })).toEqual({ output: 'File not found: /vercel/sandbox/nope.txt', isError: true });

    expect(await run('share_file', { path: 'notes.txt' })).toEqual({ output: 'Shared "notes.txt" (14 bytes) with the user.', artifacts: [{ id: 'f1', name: 'notes.txt' }] });
    expect(await run('share_file', { path: 'nope.txt' })).toEqual({ output: 'File not found: /vercel/sandbox/nope.txt', isError: true });
    // No request was cut short.
    expect(box.opened.some((o) => o.signal?.aborted)).toBe(false);
  });
});
