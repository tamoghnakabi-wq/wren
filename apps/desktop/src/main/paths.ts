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

/** Resolve `p` (relative to the first root) and require the real target to be inside a root. */
export function confinePath(p: string, roots: string[]): string {
  if (!roots.length) throw new Error('No folders are allowed on this computer. Add one in Wren → Settings → This computer.');
  const expanded = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(roots[0], expanded || '.');
  let probe = abs;
  while (!exists(probe) && dirname(probe) !== probe) probe = dirname(probe);
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    throw new Error(`"${p}" goes through a broken link, so Wren can't tell where it really points.`);
  }
  const full = resolve(real, relative(probe, abs));
  if (!roots.some((r) => within(full, r))) throw new Error(`"${p}" is outside the folders you allowed (${roots.join(', ')}).`);
  return full;
}

export function isConfined(p: string, roots: string[]): boolean {
  try {
    confinePath(p, roots);
    return true;
  } catch {
    return false;
  }
}
