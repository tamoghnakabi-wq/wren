import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
process.env.WREN_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'wren-data-')));
const { claudeSupportsRestricted, cliHelpKnown, effortFlag, spawnClaude } = await import('../src/engines/common');

// Which flags an engine CLI has comes from its help text, read once per program file. A probe that failed
// (a busy moment, a time-out) used to be kept too, so that version looked "too old for Wren" until a restart.

/** A stand-in CLI whose first `--help` fails with no output and whose later ones list the flags. */
function flakyCli() {
  const dir = mkdtempSync(join(tmpdir(), 'wren-cli-'));
  const seen = join(dir, 'asked-once');
  const cli = join(dir, 'claude');
  writeFileSync(cli, `#!/bin/sh\nif [ ! -e '${seen}' ]; then : > '${seen}'; exit 1; fi\necho '  --restricted   Restricted mode'\necho '  --effort <level>   How hard to think'\n`);
  chmodSync(cli, 0o755);
  return { cli, seen };
}

describe.skipIf(process.platform === 'win32')('engine CLI help', () => {
  it('asks again a little after a probe that failed, and keeps a good answer', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { cli, seen } = flakyCli();
      expect(claudeSupportsRestricted(cli)).toBe(false);
      expect(existsSync(seen)).toBe(true);
      // Claude Code's start then says the options couldn't be read, not that the version is too old.
      expect(cliHelpKnown(cli)).toBe(false);
      // Not asked again at once (each try can hold the app up for 20 s): the effort check right after gets nothing.
      expect(effortFlag('claude-code', cli)).toBeNull();
      vi.setSystemTime(Date.now() + 31_000);
      expect(claudeSupportsRestricted(cli)).toBe(true);
      expect(cliHelpKnown(cli)).toBe(true);
      expect(effortFlag('claude-code', cli)).toBe('--effort');
      // Kept: a later failure of the program doesn't change what this version was seen to have.
      writeFileSync(cli, '#!/bin/sh\nexit 1\n');
      expect(claudeSupportsRestricted(cli)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(process.platform === 'win32')('starting Claude Code', () => {
  it('gives every run limits on Wren’s MCP calls longer than Wren’s own waits', async () => {
    // Claude Code 2.1.322 ends a call to a stdio MCP server after 30 minutes without word from it, so a
    // permission prompt left for half an hour failed even with the helpers fixed (0.1.47).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wren-cli-')));
    const out = join(dir, 'env.txt');
    const cli = join(dir, 'claude');
    writeFileSync(cli, `#!/bin/sh\nenv > '${out}'\n`);
    chmodSync(cli, 0o755);
    const child = await spawnClaude(cli, [], { runId: 'r-env', engine: 'claude-code', cwd: dir, folders: [dir] } as never, cli);
    await new Promise((ok) => child.on('exit', ok));
    const env = readFileSync(out, 'utf8');
    expect(env).toMatch(/^MCP_TOOL_TIMEOUT=3900000$/m);
    expect(env).toMatch(/^CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=3900000$/m);
  });
});
