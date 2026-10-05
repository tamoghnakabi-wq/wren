import type { ChildProcess } from 'node:child_process';
import { killTree, treeAlive } from './proctree';

// Shell commands agents started on this computer. A command stays on record until nothing it
// started is still running, not just until it returns, so stopping its run, quitting or
// installing an update still reaches whatever it left behind (`server &` keeps going after the
// command itself has returned). A stop that couldn't be confirmed keeps the record too: the next
// attempt (an update retried) still has to deal with it.

export interface Job {
  proc: ChildProcess;
  out: string;
  exit: number | null;
  started: number;
  /** The run that started it: its jobs (background ones included) end with it. */
  runId: string;
  /** Being stopped. */
  stopping?: boolean;
}

export const jobs = new Map<string, Job>();

/** The command has returned: forget it once nothing it started is still running. */
export async function release(id: string, j: Job) {
  if (jobs.get(id) === j && !(await treeAlive(j.proc).catch(() => true))) jobs.delete(id);
}

/**
 * Stop a command and everything it started: its process group on macOS/Linux (it runs in its
 * own), the process tree on Windows. A polite stop first, then a forced one after `graceMs`
 * whether or not the first was obeyed (a command can ignore SIGTERM).
 */
export function kill(p: ChildProcess, graceMs = 3000): Promise<boolean> {
  if (!p.pid) p.kill();
  return killTree(p, graceMs).catch(() => false);
}

async function stop(id: string, j: Job, graceMs: number): Promise<boolean> {
  j.stopping = true;
  const gone = await kill(j.proc, graceMs);
  if (gone && jobs.get(id) === j) jobs.delete(id);
  return gone;
}

/** End every command (and what it started) at once; resolves whether all are confirmed gone. */
export async function stopAllJobs(): Promise<boolean> {
  const done = await Promise.all([...jobs].map(([id, j]) => stop(id, j, 0)));
  return done.every(Boolean);
}

/** Stop the commands a run started (foreground or background, and what they left running); other runs' jobs keep going. */
export function killRunJobs(runId?: string) {
  for (const [id, j] of jobs) if (!runId || j.runId === runId) void stop(id, j, 3000);
}
