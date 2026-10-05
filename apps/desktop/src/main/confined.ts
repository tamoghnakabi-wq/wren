import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileOpsProfile, hasSeatbelt } from './sandbox';

// File reads and writes the agent asks for. A path is checked against the
// allowed folders first (paths.ts), but a folder could be swapped for a link
// between that check and the open. On macOS the read/write itself therefore
// runs in a tiny helper under a Seatbelt profile that only permits the allowed
// folders, so the kernel resolves the final path and refuses anything outside.

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

/** Read a file already checked to be inside `roots`. */
export async function readConfined(path: string, roots: string[], dataDir: string, max: number): Promise<Buffer> {
  if (hasSeatbelt()) return helper(['/bin/cat', '--', path], roots, dataDir, null, max);
  // Elsewhere: at least never follow a link at the last component.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
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
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o644);
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
}
