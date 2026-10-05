import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { confinePath } from './paths';
import { fileOpsProfile, hasSeatbelt } from './sandbox';

// File reads, writes and listings the agent asks for. A path is checked against
// the allowed folders first (paths.ts), but a folder could be swapped for a link
// between that check and the open. On macOS the operation itself therefore runs
// in a tiny helper under a Seatbelt profile that only permits the allowed
// folders (and the system runtime the helper loads), so the kernel resolves the
// final path and refuses anything outside. Elsewhere the opened file is checked
// afterwards to be the one inside the allowed folders.

export class TooLarge extends Error {}

function helper(args: string[], roots: string[], dataDir: string, input: Buffer | null, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('/usr/bin/sandbox-exec', ['-p', fileOpsProfile(roots, dataDir), ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
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
  if (a.ino !== b.ino || a.dev !== b.dev) throw new Error('The file changed while it was being opened, so Wren stopped.');
}

/** Read a file already checked to be inside `roots`. */
export async function readConfined(path: string, roots: string[], dataDir: string, max: number): Promise<Buffer> {
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
  if (hasSeatbelt()) {
    await helper(['/bin/sh', '-c', '/bin/mkdir -p -- "$(/usr/bin/dirname -- "$1")" && /bin/cat > "$1"', 'sh', path], roots, dataDir, content, 0);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  // Opened without truncating, checked, and only then emptied and written.
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    verifyOpened(fd, path, roots);
    ftruncateSync(fd, 0);
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/** Entries under a folder already checked to be inside `roots`: "d|f|l size path" lines, links never followed. */
export async function listConfined(root: string, depth: number, roots: string[], dataDir: string, limit = 500): Promise<string[]> {
  if (hasSeatbelt()) {
    const script = '/usr/bin/find -P "$1" -mindepth 1 -maxdepth "$2" \\( -name node_modules -o -name .git \\) -prune -o -print0 | /usr/bin/xargs -0 /usr/bin/stat -f "%HT|%z|%N" | /usr/bin/head -n "$3"';
    const out = (await helper(['/bin/sh', '-c', script, 'sh', root, String(depth), String(limit)], roots, dataDir, null, 4 * 1024 * 1024)).toString('utf8');
    const kind = (t: string) => (t === 'Directory' ? 'd' : t === 'Symbolic Link' ? 'l' : 'f');
    return out
      .split('\n')
      .filter(Boolean)
      .slice(0, limit)
      .map((line) => {
        const [t, size, ...rest] = line.split('|');
        return `${kind(t)} ${size} ${rest.join('|')}`;
      });
  }
  const out: string[] = [];
  const walk = (d: string, level: number) => {
    if (out.length >= limit) return;
    confinePath(d, roots); // still inside before reading it
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === '.git' || out.length >= limit) continue;
      const full = join(d, name);
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
