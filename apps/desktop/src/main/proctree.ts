import { type ChildProcess, execFile, spawn } from 'node:child_process';

// Stopping a process together with everything it started, and knowing when nothing is left.
// macOS/Linux: agent processes lead their own process group (spawn's `detached`); the group is
// signalled and polled until no member is left. Windows: shell commands put themselves in a Job
// Object that ends everything in it when the command's own process exits (winjob.ts); on top of
// that, what a process started is found by parent id (Windows never re-parents an orphan) and
// ended with taskkill, so nothing counts as stopped until no such process is left.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A process stopped with everything it started: one Wren spawned, or the agent browser (`external`). */
export interface Proc {
  readonly pid?: number;
  kill?(): boolean;
}

/**
 * When each tracked process started and ended: on Windows the window in which its children count as its
 * own. `born` is the process's own creation time as Windows reported it, when known (W-144).
 */
const life = new WeakMap<Proc, { start: number; end?: number; born?: number }>();

/** Note a process's lifetime; call right after spawning it. */
export function tracked<P extends ChildProcess>(p: P): P {
  const l: { start: number; end?: number } = { start: Date.now() };
  life.set(p, l);
  p.once('exit', () => (l.end = Date.now()));
  return p;
}

/**
 * A process Wren didn't spawn itself but knows the id of, started no earlier than `start`: the agent
 * browser, which Playwright starts (leading its own process group on macOS) and which reports its own id.
 * `born` (its creation time, looked up when the id was learnt) tells it from a process given its id later.
 */
export function external(pid: number, start: number, born?: number): Proc {
  const p: Proc = { pid };
  life.set(p, { start, born });
  return p;
}

/** When `p` was created, if known (see `external`). */
export function bornOf(p: Proc): number | undefined {
  return life.get(p)?.born;
}

/** `p` is known to have ended: on Windows, a process its id is given to later isn't its child. */
export function ended(p: Proc) {
  const l = life.get(p);
  if (l && l.end === undefined) l.end = Date.now();
}

/** Whether any process of the group led by `pid` is still running. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(gone: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!(await gone())) {
    if (Date.now() >= end) return false;
    await sleep(50);
  }
  return true;
}

export interface WinProc {
  pid: number;
  ppid: number;
  /** Creation time, ms since the epoch. */
  created: number;
}

/** Every running process (Windows), or null if the list couldn't be read. */
export function windowsProcesses(): Promise<WinProc[] | null> {
  const script =
    "Get-CimInstance Win32_Process | Where-Object CreationDate | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null);
      const list = out
        .split(/\r?\n/)
        .map((l) => l.trim().split(' ').map(Number))
        .filter((f) => f.length === 3 && f.every(Number.isFinite))
        .map(([pid, ppid, created]) => ({ pid, ppid, created }));
      resolve(list.length ? list : null);
    });
  });
}

/**
 * `root` (if it still runs) and every process it started, and they started, in `list`. A child
 * counts only if it was created while its parent was alive, so a process id the system has
 * since reused is not followed. With `born` (the root's own creation time) the root is that process
 * exactly: another process holding its id now is someone else's, and only appeared after it ended.
 */
export function windowsTree(list: WinProc[], root: number, from: number, to: number, born?: number): WinProc[] {
  const slack = 5000;
  let lo = from - slack;
  let hi = to + slack;
  if (born !== undefined) {
    const holder = list.find((x) => x.pid === root);
    lo = born;
    if (holder && Math.abs(holder.created - born) > 50) hi = Math.min(hi, holder.created);
  }
  const isRoot = (x: WinProc) => x.pid === root && (born !== undefined ? Math.abs(x.created - born) <= 50 : x.created >= lo && x.created <= hi);
  const out = list.filter(isRoot);
  const queue = [{ pid: root, from: lo, to: hi }];
  const seen = new Set([root]);
  while (queue.length) {
    const parent = queue.shift()!;
    for (const x of list) {
      if (x.ppid !== parent.pid || seen.has(x.pid) || x.created < parent.from || x.created > parent.to) continue;
      seen.add(x.pid);
      out.push(x);
      queue.push({ pid: x.pid, from: x.created, to: Infinity });
    }
  }
  return out;
}

/** What is still running of `p` on Windows (itself included); null if that couldn't be read. */
async function windowsMembers(p: Proc): Promise<WinProc[] | null> {
  const l = life.get(p) ?? { start: 0 };
  const list = await windowsProcesses();
  return list && windowsTree(list, p.pid!, l.start, l.end ?? Date.now(), l.born);
}

function taskkill(pids: number[]): Promise<void> {
  return new Promise((resolve) => {
    const k = spawn('taskkill', ['/F', '/T', ...pids.flatMap((pid) => ['/PID', String(pid)])], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => resolve());
    k.on('close', () => resolve());
  });
}

/** Whether `p` or anything it started may still be running (unknown counts as running). */
export async function treeAlive(p: Proc): Promise<boolean> {
  if (!p.pid) return false;
  if (process.platform !== 'win32') return groupAlive(p.pid);
  const members = await windowsMembers(p);
  return members === null || members.length > 0;
}

/**
 * Stop `p` and its descendants: SIGTERM, then SIGKILL after `graceMs` (at once when 0); on
 * Windows taskkill, repeated until nothing is left. Resolves true once nothing is left, false if
 * that couldn't be confirmed within `waitMs`.
 */
export async function killTree(p: Proc, graceMs = 3000, waitMs = 5000): Promise<boolean> {
  const pid = p.pid;
  if (!pid) return true; // never started
  if (process.platform === 'win32') {
    const end = Date.now() + Math.max(waitMs, 10_000);
    for (;;) {
      const members = await windowsMembers(p);
      if (members && members.length === 0) return true;
      if (Date.now() >= end) return false;
      if (members) await taskkill(members.map((m) => m.pid));
      else p.kill?.();
      await sleep(250);
    }
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
