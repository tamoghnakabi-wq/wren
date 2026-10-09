import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmdirSync, statSync, unlinkSync, writeSync, type BigIntStats } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { confinePath } from './paths';
import { appDirs, fileOpsProfile, hasSeatbelt } from './sandbox';

// File reads, writes and listings the agent asks for. A path is checked against
// the allowed folders first (paths.ts), but a folder could be swapped for a link
// between that check and the open. On macOS the operation itself therefore runs
// in a tiny helper under a Seatbelt profile that only permits the allowed
// folders (and the few system files the helper needs to start), so the kernel
// resolves the final path and refuses anything outside. Elsewhere (Windows) Node
// has no handle-relative file API, so every folder on the way is checked not to
// be a link or junction, nothing is created until its parent has been checked,
// and what was opened or created is checked afterwards to be inside the allowed
// folders (and removed again if it isn't). Each check and the step after it are
// still separate operations there: a folder swapped for a junction at exactly the
// wrong moment can get an empty file or folder created outside (nothing is ever
// written into it: the opened file is checked first), and a listing can show the
// names in the swapped-in folder. Only a process running at the same time can do
// that swap, and on Windows such a process (an agent command, which always needs
// approval there) already has the user's full access, so it gains nothing.

export class TooLarge extends Error {}

function helper(args: string[], roots: string[], dataDir: string, input: Buffer | null, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('/usr/bin/sandbox-exec', ['-p', fileOpsProfile(roots, dataDir), ...args], { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
    const chunks: Buffer[] = [];
    let size = 0;
    let err = '';
    let over = false;
    p.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        over = true;
        p.kill();
      } else chunks.push(c);
    });
    p.stderr.on('data', (c) => (err = (err + c).slice(-2000)));
    p.on('error', reject);
    p.on('close', (code) => {
      if (over) return reject(new TooLarge(`larger than ${Math.round(max / 1024 / 1024)} MB`));
      if (code === 0) return resolve(Buffer.concat(chunks));
      if (/Operation not permitted/i.test(err)) return reject(new Error('Access was refused: the file is outside the folders you allowed (or goes through a link that leads outside them).'));
      if (/No such file/i.test(err)) return reject(Object.assign(new Error('File not found.'), { code: 'ENOENT' }));
      reject(new Error(err.trim().split('\n').pop() || `The file operation failed (${code}).`));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? undefined);
  });
}

/** After opening by name: the handle must be the file the path resolves to now, inside the roots. */
function verifyOpened(fd: number, path: string, roots: string[]) {
  const real = confinePath(path, roots); // throws if it now resolves outside
  const a = fstatSync(fd, { bigint: true });
  const b = statSync(real, { bigint: true });
  if (!sameFile(a, b)) throw new Error('The file changed while it was being opened, so Wren stopped.');
}

const sameFile = (a: BigIntStats, b: BigIntStats) => a.ino === b.ino && a.dev === b.dev;
const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Wren's own data (its policy, the device's sign-in, updates, approval folders) and Wren itself: the file
 * tools never read, write or list them, whatever folders are allowed (W-128, W-134). On macOS the helper's
 * profile denies them as well; on Windows this check is all there is. Windows paths compare without case.
 */
function privateRoots(dataDir: string): string[] {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return [real(dataDir), ...appDirs()];
}
const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const isPrivate = (p: string, dataDir: string) => privateRoots(dataDir).some((r) => within(fold(p), fold(r)));
function refusePrivate(p: string, dataDir: string) {
  if (isPrivate(p, dataDir)) throw new Error(`"${p}" is part of Wren itself, so the agent can't use it.`);
}

function lstatOrNull(p: string): BigIntStats | null {
  try {
    return lstatSync(p, { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** A real folder (not a link or junction) whose real location is inside the roots. */
function checkFolder(dir: string, roots: string[]): BigIntStats {
  const st = lstatSync(dir, { bigint: true });
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`"${dir}" is a link or not a folder, so Wren won't go through it.`);
  confinePath(dir, roots);
  return st;
}

/**
 * Make sure `dir` exists, walking down from the allowed folder that contains it and creating
 * missing folders one level at a time, each only after its parent was checked. A folder that
 * turns out to have been made outside the roots is removed again.
 */
function ensureFolder(dir: string, roots: string[]) {
  const root = roots.filter((r) => within(dir, r)).sort((a, b) => b.length - a.length)[0];
  if (!root) throw new Error(`"${dir}" is outside the folders you allowed.`);
  let cur = root;
  let parent = checkFolder(cur, roots);
  for (const part of relative(root, dir).split(sep).filter(Boolean)) {
    const next = join(cur, part);
    if (!lstatOrNull(next)) {
      // The parent must still be the folder that was just checked.
      const now = lstatSync(cur, { bigint: true });
      if (!sameFile(now, parent) || now.isSymbolicLink()) throw new Error('A folder changed while Wren was writing, so it stopped.');
      try {
        mkdirSync(next);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      try {
        checkFolder(next, roots);
      } catch (e) {
        try {
          rmdirSync(next);
        } catch {
          /* not empty or already gone: leave it */
        }
        throw e;
      }
    }
    parent = checkFolder(next, roots);
    cur = next;
  }
}

/** Read a file already checked to be inside `roots`. */
export async function readConfined(path: string, roots: string[], dataDir: string, max: number): Promise<Buffer> {
  refusePrivate(path, dataDir);
  if (hasSeatbelt()) return helper(['/bin/cat', '--', path], roots, dataDir, null, max);
  // Elsewhere: never follow a link at the last component, and check what was opened.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    verifyOpened(fd, path, roots);
    const size = fstatSync(fd).size;
    if (size > max) throw new TooLarge(`larger than ${Math.round(max / 1024 / 1024)} MB`);
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (!n) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

/** Create or replace a file already checked to be inside `roots` (parent folders included). */
export async function writeConfined(path: string, content: Buffer, roots: string[], dataDir: string): Promise<void> {
  refusePrivate(path, dataDir);
  if (hasSeatbelt()) {
    await helper(['/bin/sh', '-c', '/bin/mkdir -p -- "$(/usr/bin/dirname -- "$1")" && /bin/cat > "$1"', 'sh', path], roots, dataDir, content, 0);
    return;
  }
  ensureFolder(dirname(path), roots);
  const existing = lstatOrNull(path);
  if (existing?.isSymbolicLink()) throw new Error(`"${path}" is a link, so Wren won't write through it.`);
  // A new file is created exclusively (never through something already there); an existing one is
  // opened without creating or truncating. Either way it's checked before anything is written.
  const nofollow = constants.O_NOFOLLOW ?? 0;
  const fd = existing ? openSync(path, constants.O_WRONLY | nofollow) : openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o644);
  try {
    try {
      verifyOpened(fd, path, roots);
    } catch (e) {
      if (!existing) removeIfSame(path, fd);
      throw e;
    }
    ftruncateSync(fd, 0);
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/** Remove the file just created at `path`, but only if the name still leads to that very file. */
function removeIfSame(path: string, fd: number) {
  try {
    const st = lstatOrNull(path);
    if (st && !st.isSymbolicLink() && sameFile(st, fstatSync(fd, { bigint: true }))) unlinkSync(path);
  } catch {
    /* best effort */
  }
}

/** Entries under a folder already checked to be inside `roots`: "d|f|l size path" lines, links never followed. */
export async function listConfined(root: string, depth: number, roots: string[], dataDir: string, limit = 500): Promise<string[]> {
  refusePrivate(root, dataDir);
  if (hasSeatbelt()) {
    const script = '/usr/bin/find -P "$1" -mindepth 1 -maxdepth "$2" \\( -name node_modules -o -name .git \\) -prune -o -print0 | /usr/bin/xargs -0 /usr/bin/stat -f "%HT|%z|%N" | /usr/bin/head -n "$3"';
    const out = (await helper(['/bin/sh', '-c', script, 'sh', root, String(depth), String(limit)], roots, dataDir, null, 4 * 1024 * 1024)).toString('utf8');
    const kind = (t: string) => (t === 'Directory' ? 'd' : t === 'Symbolic Link' ? 'l' : 'f');
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [t, size, ...rest] = line.split('|');
        return { line: `${kind(t)} ${size} ${rest.join('|')}`, path: rest.join('|') };
      })
      .filter((e) => !isPrivate(e.path, dataDir)) // Wren's own folders aren't listed (its build in a project included)
      .slice(0, limit)
      .map((e) => e.line);
  }
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    if (out.length >= limit) return;
    const before = checkFolder(d, roots); // a real folder, still inside, before reading it
    const names = readdirSync(d);
    // ...and still that same folder after: what was listed is what was checked.
    if (!sameFile(before, lstatSync(d, { bigint: true }))) throw new Error('A folder changed while Wren was listing it, so it stopped.');
    for (const name of names) {
      if (name === 'node_modules' || name === '.git' || out.length >= limit) continue;
      const full = join(d, name);
      if (isPrivate(full, dataDir)) continue; // Wren's own folders aren't listed either
      let st;
      try {
        st = lstatSync(full); // never follow links out of the folder
      } catch {
        continue;
      }
      out.push(`${st.isSymbolicLink() ? 'l' : st.isDirectory() ? 'd' : 'f'} ${st.size} ${full}`);
      if (st.isDirectory() && level < depth) walk(full, level + 1);
    }
  };
  walk(root, 1);
  return out;
}
