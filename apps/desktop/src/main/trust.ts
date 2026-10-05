import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ProgramTrust } from '@wren/core';
import { agentWritable, hasSeatbelt } from './sandbox';
import { toolEnv } from './shellenv';

// Which bare program names ("ls", "git") run a program an agent can't have put there. bash runs the
// first match on PATH, so a name counts only if it is found before any PATH folder agents can
// write: a later write can't then put something in front of it, even by a background job racing
// the check. Used for read-only ratings and for replaying a read-only command after a crash.

/** bash builtins in Wren's read-only list: they never look at PATH. */
const BASH_BUILTINS = new Set(['pwd', 'echo', 'printf', 'type', 'true', 'false', 'test', 'help']);

/** Where `p` really is, following links as far as the path exists. */
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    const d = dirname(p);
    return d === p ? p : join(real(d), basename(p));
  }
}

export function programTrust(path: string, writable: string[], platform = process.platform): ProgramTrust {
  // macOS volumes are usually case-insensitive: compare that way, which errs towards "writable".
  const norm = (p: string) => (platform === 'darwin' ? p.toLowerCase() : p);
  const unsafe = writable.map((d) => norm(real(d)));
  const inWritable = (p: string) => {
    const n = norm(real(p));
    return unsafe.some((d) => n === d || n.startsWith(d.endsWith('/') ? d : `${d}/`));
  };
  const trusted: string[] = [];
  for (const d of path.split(':')) {
    if (!d) continue;
    if (inWritable(d)) break; // from here on an agent could put any program first
    trusted.push(d);
  }
  return (name) => {
    if (BASH_BUILTINS.has(name)) return true;
    if (!name || name.includes('/')) return false;
    for (const d of trusted) {
      const f = join(d, name);
      try {
        if (!statSync(f).isFile()) continue;
        accessSync(f, constants.X_OK);
      } catch {
        continue;
      }
      return !inWritable(f); // a link into a writable folder is as good as a file there
    }
    return false;
  };
}

/** The trust check for agent shell commands right now, with these allowed folders. */
export async function currentProgramTrust(roots: string[]): Promise<ProgramTrust> {
  // PowerShell runs cmdlets (Verb-Noun) ahead of any program on PATH; nothing else is vouched for.
  if (process.platform === 'win32') return (name) => /^[a-z]+-[a-z]+$/i.test(name);
  // Without the sandbox, commands run in a login shell whose PATH Wren doesn't know.
  if (!hasSeatbelt()) return () => false;
  return programTrust((await toolEnv()).PATH ?? '', agentWritable(roots));
}
