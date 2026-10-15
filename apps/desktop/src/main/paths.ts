import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// Folder confinement shared by the file tools and the CLI engines' permission
// checks. Symlinks are resolved, including broken ones: a link that points
// nowhere yet would otherwise pass the check and then be followed on write.

export function allowedRoots(folders: string[]): string[] {
  return folders.map((f) => {
    try {
      return realpathSync(f);
    } catch {
      return resolve(f);
    }
  });
}

const exists = (p: string) => {
  try {
    lstatSync(p); // does not follow links, so a dangling link still "exists"
    return true;
  } catch {
    return false;
  }
};

const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Where `p` (relative to `base`) really points, links followed (the part that exists so far). */
function realTarget(p: string, base: string): string {
  const expanded = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded || '.');
  let probe = abs;
  while (!exists(probe) && dirname(probe) !== probe) probe = dirname(probe);
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    throw new Error(`"${p}" goes through a broken link, so Wren can't tell where it really points.`);
  }
  return resolve(real, relative(probe, abs));
}

/** Resolve `p` (relative to the first root) and require the real target to be inside a root. */
export function confinePath(p: string, roots: string[]): string {
  if (!roots.length) throw new Error('No folders are allowed on this computer. Add one in Wren → Settings → This computer.');
  const full = realTarget(p, roots[0]);
  if (!roots.some((r) => within(full, r))) throw new Error(`"${p}" is outside the folders you allowed (${roots.join(', ')}).`);
  return full;
}

/**
 * Whether `p`, as written or where it really points, is in (or, for a file name, starts with) one of
 * `paths`. Case is ignored on macOS and Windows, whose disks usually do; a link that can't be followed counts.
 */
export function reachesAny(p: string, base: string, paths: string[]): boolean {
  const fold = (s: string) => (process.platform === 'linux' ? s : s.toLowerCase());
  const hit = (full: string) => paths.some((r) => within(fold(full), fold(r)) || fold(full).startsWith(fold(r) + '.'));
  try {
    const expanded = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
    return hit(isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded || '.')) || hit(realTarget(p, base));
  } catch {
    return true;
  }
}

export function isConfined(p: string, roots: string[]): boolean {
  try {
    confinePath(p, roots);
    return true;
  } catch {
    return false;
  }
}
