import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
const { appDirs, engineProfile, fileOpsProfile, seatbeltProfile } = await import('../src/main/sandbox');
const { writeConfined } = await import('../src/main/confined');

// W-128: what decides approvals (Wren's helper, Grok's per-run hook plugin) can't be changed by any agent,
// even when an allowed folder contains it. Run in the real macOS sandbox.
const sb = (profile: string, cmd: string) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', cmd], { encoding: 'utf8' });

describe.skipIf(!existsSync('/usr/bin/sandbox-exec'))('trusted files in the sandbox (W-128)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wren-integrity-')));
  const project = join(root, 'project'); // an allowed folder...
  const helperDir = join(project, 'release', 'Wren.app', 'dist'); // ...that contains a build of Wren
  const data = join(root, 'data');
  const plugin = join(data, 'engines', 'grok-run1');
  mkdirSync(helperDir, { recursive: true });
  mkdirSync(join(plugin, 'hooks'), { recursive: true });
  writeFileSync(join(helperDir, 'mcp-approve.mjs'), 'original');
  writeFileSync(join(plugin, 'hooks', 'hooks.json'), 'hook');

  it("keeps Wren's helpers unwritable inside an allowed folder, for commands and engines alike", () => {
    for (const profile of [seatbeltProfile([project], data, undefined, [helperDir]), engineProfile('grok-build', [project], data, [helperDir])]) {
      expect(sb(profile, `echo x > ${join(project, 'ok.txt')}`).status).toBe(0); // the folder itself is writable
      expect(sb(profile, `echo allow-all > ${join(helperDir, 'mcp-approve.mjs')}`).status).not.toBe(0);
      expect(sb(profile, `cat ${join(helperDir, 'mcp-approve.mjs')}`).stdout).toBe('original'); // still readable
    }
    expect(readFileSync(join(helperDir, 'mcp-approve.mjs'), 'utf8')).toBe('original');
    // This app's own folders are protected even when a caller passes none (Wren's file tools).
    const own = appDirs()[0];
    expect(fileOpsProfile([own], data)).toContain(`(deny file-write* (subpath ${JSON.stringify(own)})`);
  });

  it("lets Grok read its per-run plugin, and nobody write it (another task's commands can't even read it)", () => {
    const grok = engineProfile('grok-build', [project], data, [helperDir], undefined, [plugin]);
    expect(sb(grok, `cat ${join(plugin, 'hooks', 'hooks.json')}`).stdout).toBe('hook');
    // Grok resolves the plugin path through the data folder: without lookups there it silently loaded no
    // hook, and ran writes without asking (found with grok 1.0.46).
    expect(sb(grok, `/bin/realpath ${join(plugin, 'hooks', 'hooks.json')}`).stdout.trim()).toBe(join(plugin, 'hooks', 'hooks.json'));
    expect(sb(grok, `ls ${data}`).status).not.toBe(0); // looking a path up isn't listing the data folder
    expect(sb(grok, `echo '{}' > ${join(plugin, 'hooks', 'hooks.json')}`).status).not.toBe(0);
    const command = seatbeltProfile([project], data, undefined, [helperDir]);
    expect(sb(command, `cat ${join(plugin, 'hooks', 'hooks.json')}`).stdout).toBe('');
    expect(sb(command, `echo '{}' > ${join(plugin, 'hooks', 'hooks.json')}`).status).not.toBe(0);
    expect(readFileSync(join(plugin, 'hooks', 'hooks.json'), 'utf8')).toBe('hook');
  });
});

describe("Wren's own file tool (W-128)", () => {
  it('refuses to write into Wren itself, even inside an allowed folder', async () => {
    const own = appDirs()[0];
    await expect(writeConfined(join(own, 'mcp-approve.mjs'), Buffer.from('x'), [own], mkdtempSync(join(tmpdir(), 'wren-d-')))).rejects.toThrow(/part of Wren itself/);
  });
});
