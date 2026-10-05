import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// W-76: a command's record outlives the command until everything it started is confirmed gone.

const h = vi.hoisted(() => ({ gone: new Map<number, boolean>(), alive: new Map<number, boolean>(), kills: [] as number[] }));
vi.mock('../src/main/proctree', () => ({
  killTree: async (p: ChildProcess) => (h.kills.push(p.pid!), h.gone.get(p.pid!) ?? true),
  treeAlive: async (p: ChildProcess) => h.alive.get(p.pid!) ?? false,
}));
const { jobs, killRunJobs, release, stopAllJobs } = await import('../src/main/jobs');

const proc = (pid: number) => Object.assign(new EventEmitter(), { pid, kill: () => true }) as unknown as ChildProcess;
const add = (id: string, pid: number, runId = 'r1') => jobs.set(id, { proc: proc(pid), out: '', exit: null, started: 0, runId });
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  jobs.clear();
  h.gone.clear();
  h.alive.clear();
  h.kills = [];
});

describe('job records', () => {
  it('keeps a command whose stop was not confirmed, so a retried update still has to stop it', async () => {
    add('a', 101);
    add('b', 102);
    h.gone.set(101, false);
    expect(await stopAllJobs()).toBe(false);
    expect([...jobs.keys()]).toEqual(['a']);
    // The retry tries again rather than finding nothing to stop.
    h.kills = [];
    expect(await stopAllJobs()).toBe(false);
    expect(h.kills).toEqual([101]);
    h.gone.set(101, true);
    expect(await stopAllJobs()).toBe(true);
    expect(jobs.size).toBe(0);
  });

  it('keeps a finished command on record while something it started still runs', async () => {
    add('a', 201);
    const j = jobs.get('a')!;
    j.exit = 0;
    h.alive.set(201, true);
    await release('a', j);
    expect(jobs.has('a')).toBe(true);
    // ...so stopping its run reaches what it left behind.
    killRunJobs('r1');
    await settle();
    expect(h.kills).toEqual([201]);
    expect(jobs.has('a')).toBe(false);
  });

  it('forgets a finished command once nothing of it is left', async () => {
    add('a', 301);
    await release('a', jobs.get('a')!);
    expect(jobs.has('a')).toBe(false);
  });

  it('stops only the given run, and keeps the record if that stop fails', async () => {
    add('a', 401, 'r1');
    add('b', 402, 'r2');
    h.gone.set(401, false);
    killRunJobs('r1');
    await settle();
    expect(h.kills).toEqual([401]);
    expect([...jobs.keys()].sort()).toEqual(['a', 'b']);
  });
});
