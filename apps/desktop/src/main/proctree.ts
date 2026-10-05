import { type ChildProcess, spawn } from 'node:child_process';

// Stopping a process together with everything it started. On macOS/Linux agent processes are
// started as the leader of their own process group (spawn's `detached`), so the group is
// signalled and then polled until no member is left; on Windows taskkill ends the tree.
// Each stop resolves to whether the processes are confirmed gone.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether any process of the group led by `pid` is still running. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(gone: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!gone()) {
    if (Date.now() >= end) return false;
    await sleep(50);
  }
  return true;
}

/**
 * Stop `p` and its descendants: SIGTERM, then SIGKILL after `graceMs` (at once when 0).
 * Resolves true once nothing is left, false if that couldn't be confirmed within `waitMs`.
 */
export async function killTree(p: ChildProcess, graceMs = 3000, waitMs = 5000): Promise<boolean> {
  const pid = p.pid;
  if (!pid) return true; // never started
  if (process.platform === 'win32') {
    if (!pidAlive(pid)) return true;
    const ended = await new Promise<number | null>((resolve) => {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => resolve(null));
      k.on('close', (code) => resolve(code));
    });
    // 0: the tree was ended; 128: it had already exited.
    if (ended === null) p.kill();
    return (ended === 0 || ended === 128) && until(() => !pidAlive(pid), waitMs);
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      /* already gone */
    }
  };
  if (!groupAlive(pid)) return true;
  if (graceMs > 0) {
    signal('SIGTERM');
    if (await until(() => !groupAlive(pid), graceMs)) return true;
  }
  signal('SIGKILL');
  return until(() => !groupAlive(pid), waitMs);
}

/** Whether `p` or anything in its group may still be running. */
export function treeAlive(p: ChildProcess): boolean {
  if (!p.pid) return false;
  return process.platform === 'win32' ? pidAlive(p.pid) : groupAlive(p.pid);
}
