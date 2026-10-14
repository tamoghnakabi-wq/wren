import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type LoginEngine = 'claude-code' | 'grok-build';

/**
 * The script Terminal runs to sign in to an engine's CLI (macOS). Terminal runs it outside every
 * sandbox, so it lives where agents can neither write nor read: a new folder in Wren's data folder
 * (W-172; the temp folder is theirs to write). Made fresh and exclusively, so nothing put there
 * beforehand is used. Returns the script and the folder to remove afterwards.
 */
export function engineLoginScript(dataDir: string, engine: LoginEngine): { file: string; dir: string } {
  const parent = join(dataDir, 'login');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(parent, `${engine}-`));
  const file = join(dir, `wren-${engine}-login.command`);
  const cmd = engine === 'claude-code' ? 'claude' : 'grok login';
  writeFileSync(file, `#!/bin/bash\necho "Signing in to ${engine === 'claude-code' ? 'Claude Code (type /login if asked)' : 'Grok Build'}…"\n${cmd}\n`, { mode: 0o700, flag: 'wx' });
  return { file, dir };
}
