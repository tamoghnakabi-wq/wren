import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { killTree, tracked, treeAlive, windowsTree, type WinProc } from '../src/main/proctree';

describe('windowsTree (W-76: Windows never re-parents, so children are found by parent id)', () => {
  const T = 1_000_000;
  const list: WinProc[] = [
    { pid: 10, ppid: 1, created: T }, // the command
    { pid: 11, ppid: 10, created: T + 100 }, // started by it
    { pid: 12, ppid: 11, created: T + 200 }, // started by that
    { pid: 13, ppid: 99, created: T + 300 }, // its parent (99) is gone: not reachable, not ours either
    { pid: 20, ppid: 1, created: T + 50 }, // unrelated
  ];
  it('finds the command and everything below it', () => {
    expect(windowsTree(list, 10, T, T + 1000).map((p) => p.pid).sort()).toEqual([10, 11, 12]);
  });
  it('still finds orphans after the command itself has exited', () => {
    const orphans = list.filter((p) => p.pid !== 10);
    expect(windowsTree(orphans, 10, T, T + 1000).map((p) => p.pid).sort()).toEqual([11, 12]);
  });
  it('does not follow a reused process id', () => {
    // The command exited at T+1000; a new process later got id 10 and started its own child.
    const reused: WinProc[] = [
      { pid: 10, ppid: 1, created: T + 60_000 },
      { pid: 30, ppid: 10, created: T + 61_000 },
    ];
    expect(windowsTree(reused, 10, T, T + 1000)).toEqual([]);
  });
  // W-144: a process known by its exact creation time (the agent browser) while it may still run, so with
  // no end time to go by: a process holding its id now, created at another time, is someone else.
  it('knows a root by its creation time, even before it is known to have ended', () => {
    expect(windowsTree(list, 10, T - 5000, T + 90_000, T).map((p) => p.pid).sort()).toEqual([10, 11, 12]);
    const reused: WinProc[] = [
      { pid: 11, ppid: 10, created: T + 100 }, // the real root's helper, still running
      { pid: 10, ppid: 1, created: T + 60_000 }, // the id given to another program
      { pid: 30, ppid: 10, created: T + 61_000 }, // which started its own child
    ];
    expect(windowsTree(reused, 10, T - 5000, T + 90_000, T).map((p) => p.pid)).toEqual([11]);
  });
});

describe.skipIf(process.platform === 'win32')('process groups (macOS/Linux)', () => {
  it('counts something a command left running as still running, and stops it', async () => {
    const p = tracked(spawn('/bin/bash', ['-c', 'perl -e "select(undef,undef,undef,30)" & exit 0'], { detached: true, stdio: 'ignore' }));
    await new Promise((r) => p.once('exit', r));
    expect(await treeAlive(p)).toBe(true);
    expect(await killTree(p, 0)).toBe(true);
    expect(await treeAlive(p)).toBe(false);
  });
});
