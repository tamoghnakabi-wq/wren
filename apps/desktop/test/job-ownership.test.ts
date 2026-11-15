import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
process.env.WREN_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'wren-jobs-data-')));
const { LocalHost } = await import('../src/main/host');

const project = realpathSync(mkdtempSync(join(tmpdir(), 'wren-jobs-project-')));
const policy = () => ({ folders: [project], shell: true, browser: false, screen: false }) as never;
const ctx = { runtime: 'desktop' as const, deadline: Date.now() + 60_000, callId: 'c', checkpoint: async () => {} };

describe("one task's shell jobs (W-186)", () => {
  it("can't be read or picked up by another task, even with the job's id", async () => {
    const mine = new LocalHost(policy, 'run-a', 'lease-a');
    const other = new LocalHost(policy, 'run-b', 'lease-b');
    const started = await mine.execute('computer.shell', { command: 'echo secret-output; sleep 1', background: true }, ctx);
    const id = (started as { meta?: { job?: string } }).meta?.job;
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const peek = await other.execute('computer.shell_status', { job_id: id }, ctx);
    expect(peek).toMatchObject({ isError: true, output: 'Unknown or finished job id.' });
    // Nor resumed as its own after a restart's checkpoint.
    const resumed = await other.execute('computer.shell', { command: '' }, ctx, { kind: 'job', handle: id! } as never);
    expect((resumed as { output: string }).output).not.toMatch(/secret-output/);
    // The task that started it still can.
    const own = await mine.execute('computer.shell_status', { job_id: id, wait_sec: 5 }, ctx);
    expect((own as { output: string }).output).toMatch(/secret-output/);
  }, 30_000);

  // The fix review (0.1.50): a task stops its own server without kill (high), and only its own.
  it('can be stopped by the task that started it, with everything it started, and by no other', async () => {
    const mine = new LocalHost(policy, 'run-c', 'lease-c');
    const other = new LocalHost(policy, 'run-d', 'lease-d');
    const started = await mine.execute('computer.shell', { command: 'sleep 300 & sleep 300; echo never', background: true }, ctx);
    const id = (started as { meta?: { job?: string } }).meta?.job;
    expect(await other.execute('computer.shell_stop', { job_id: id }, ctx)).toMatchObject({ isError: true, output: 'Unknown or finished job id.' });
    expect((await mine.execute('computer.shell_status', { job_id: id }, ctx)) as { output: string }).toMatchObject({ output: expect.stringMatching(/still running/) });
    const stopped = await mine.execute('computer.shell_stop', { job_id: id }, ctx);
    expect(stopped).toMatchObject({ output: expect.stringMatching(/^Stopped job/) });
    expect((stopped as { isError?: boolean }).isError).toBeFalsy();
    expect(await mine.execute('computer.shell_status', { job_id: id }, ctx)).toMatchObject({ isError: true });
  }, 30_000);
});
