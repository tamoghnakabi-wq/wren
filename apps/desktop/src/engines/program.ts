import { dataDir } from '../main/config';
import { allowedRoots } from '../main/paths';
import { checkEngineProgram, type Engine } from '../main/sandbox';
import { toolEnv } from '../main/shellenv';
import { findClis } from './common';

/**
 * The engine program Wren may start, as its real file: the first copy found that `checkEngineProgram` accepts.
 * Every use starts that same checked file (the version and --help probes, a run, sign-in in Terminal), never a
 * name looked up again later (W-183, W-187). `untrusted` says why the first copy found was refused, when none
 * was accepted; null means none is installed.
 */
export async function engineProgram(engine: Engine, folders: string[]): Promise<{ program: string } | { untrusted: string } | null> {
  await toolEnv(); // the user's PATH as their shell has it (searched, and protected), not the start-up guess
  const found = findClis(engine === 'claude-code' ? 'claude' : 'grok');
  let first: string | undefined;
  for (const cli of found) {
    const r = checkEngineProgram(engine, cli, allowedRoots(folders), dataDir());
    if ('program' in r) return r;
    first ??= r.why;
  }
  return first === undefined ? null : { untrusted: first };
}
