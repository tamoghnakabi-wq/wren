import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentEnv, SHELL_PREFIX } from '../src/main/shellenv';

// W-108: agent commands never get Wren's own environment, which may come from a terminal with
// tokens, startup hooks or programs to run. Dummy values only.
const launched = {
  HOME: '/Users/someone',
  USER: 'someone',
  LANG: 'en_AU.UTF-8',
  TMPDIR: '/tmp/x/',
  PATH: '/usr/bin:.:bin:/bin',
  GH_TOKEN: 'dummy-gh-token',
  AWS_SECRET_ACCESS_KEY: 'dummy-aws',
  OPENAI_API_KEY: 'dummy-openai',
  BASH_ENV: '/allowed/project/hook.sh',
  ENV: '/allowed/project/hook.sh',
  PAGER: './x',
  LESSOPEN: '|./x %s',
  DYLD_INSERT_LIBRARIES: '/allowed/x.dylib',
  NODE_OPTIONS: '--require /allowed/x.js',
  WREN_URL: 'http://localhost:5310',
  ELECTRON_RUN_AS_NODE: '1',
};

describe('agent command environment (W-108)', () => {
  it('passes on only allowlisted variables, then the toolchain ones', () => {
    const env = agentEnv(launched, { PATH: '/opt/homebrew/bin:/usr/bin:/bin', JAVA_HOME: '/jdk' }, 'darwin');
    expect(env).toEqual({ HOME: '/Users/someone', USER: 'someone', LANG: 'en_AU.UTF-8', TMPDIR: '/tmp/x/', PATH: '/opt/homebrew/bin:/usr/bin:/bin', JAVA_HOME: '/jdk', WREN_AGENT: '1' });
  });

  it('keeps PATH absolute-only when the toolchain lookup gave none', () => {
    expect(agentEnv(launched, {}, 'linux').PATH).toBe('/usr/bin:/bin');
  });

  it('on Windows keeps what Windows needs (any letter case), and nothing secret', () => {
    const env = agentEnv({ SYSTEMROOT: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', Path: 'C:\\Windows;.;bin', USERPROFILE: 'C:\\Users\\a', JAVA_HOME: 'C:\\jdk', GH_TOKEN: 'dummy', BASH_ENV: 'x' }, {}, 'win32');
    expect(env).toEqual({ SYSTEMROOT: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\a', JAVA_HOME: 'C:\\jdk', WREN_AGENT: '1' });
  });

  it('on Windows a toolchain PATH replaces "Path" instead of adding a second one', () => {
    const env = agentEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' }, { PATH: 'C:\\tools;C:\\Windows' }, 'win32');
    expect(Object.keys(env).filter((k) => /^path$/i.test(k))).toEqual(['PATH']);
    expect(env.PATH).toBe('C:\\tools;C:\\Windows');
  });

  it.skipIf(process.platform === 'win32')('a real shell neither sees the token nor runs the startup hook', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wren-env-'));
    const hook = join(dir, 'hook.sh');
    writeFileSync(hook, `echo ran > ${join(dir, 'ran')}\n`);
    const r = spawnSync('/bin/bash', ['-c', 'echo "token=${GH_TOKEN-none} pager=${PAGER-none}"'], { env: agentEnv({ ...launched, PATH: process.env.PATH, BASH_ENV: hook, ENV: hook }, {}), encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('token=none pager=none');
    expect(existsSync(join(dir, 'ran'))).toBe(false);
  });

  it.skipIf(!existsSync('/usr/bin/sandbox-exec'))('Claude Code\'s commands get only the allowlist through Wren\'s shell prefix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wren-prefix-'));
    const prefix = join(dir, 'wren-shell.sh');
    writeFileSync(prefix, SHELL_PREFIX, { mode: 0o700 });
    const hook = join(dir, 'hook.sh');
    writeFileSync(hook, `echo ran > ${join(dir, 'ran')}\n`);
    const r = spawnSync(prefix, ['env'], {
      env: { ...launched, PATH: '/usr/bin:/bin', HOME: dir, SHELL: '/bin/bash', BASH_ENV: hook, ANTHROPIC_API_KEY: 'dummy-claude', WREN_SHELL_SB: '(version 1)(allow default)', LANG: 'en_AU.UTF-8 x' },
      encoding: 'utf8',
    });
    const vars = Object.fromEntries(r.stdout.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(r.status, r.stderr).toBe(0);
    // The shell adds PWD, SHLVL, _ (and TERM=dumb) itself.
    expect(Object.keys(vars).filter((k) => !['PWD', 'SHLVL', '_', 'TERM'].includes(k)).sort()).toEqual(['HOME', 'LANG', 'PATH', 'SHELL', 'TMPDIR', 'USER', 'WREN_AGENT'].sort());
    expect(r.stdout).not.toMatch(/dummy|BASH_ENV|PAGER|NODE_OPTIONS|DYLD_/);
    expect(vars.LANG).toBe('en_AU.UTF-8 x'); // values with spaces stay whole
    expect(existsSync(join(dir, 'ran'))).toBe(false);
    expect(readFileSync(prefix, 'utf8')).not.toContain('dummy');
  });

  it.skipIf(!existsSync('/usr/bin/sandbox-exec'))('lets Wren\'s approval server, and only it, keep its own variables', () => {
    // Claude Code starts MCP servers through the prefix too (verified with 2.1.294), with the variables
    // from --mcp-config. Without them every action needing permission was refused ("Wren is not reachable").
    const dir = mkdtempSync(join(tmpdir(), 'wren-prefix-'));
    const prefix = join(dir, 'wren-shell.sh');
    writeFileSync(prefix, SHELL_PREFIX, { mode: 0o700 });
    const base = { ...launched, PATH: '/usr/bin:/bin', HOME: dir, SHELL: '/bin/bash', WREN_SHELL_SB: '(version 1)(allow default)' };
    const vars = (env: NodeJS.ProcessEnv) => spawnSync(prefix, ['env'], { env, encoding: 'utf8' }).stdout;
    const server = vars({ ...base, WREN_APPROVAL_URL: 'http://127.0.0.1:5555', WREN_APPROVAL_TOKEN: 'dummy-bridge', ELECTRON_RUN_AS_NODE: '1' });
    expect(server).toContain('WREN_APPROVAL_URL=http://127.0.0.1:5555\n');
    expect(server).toContain('WREN_APPROVAL_TOKEN=dummy-bridge\n');
    expect(server).toContain('ELECTRON_RUN_AS_NODE=1\n');
    expect(server).not.toMatch(/dummy-gh|dummy-aws|BASH_ENV|NODE_OPTIONS/);
    // A command (no approval token in Claude Code's own environment) gets none of them.
    expect(vars({ ...base, ELECTRON_RUN_AS_NODE: '1', WREN_APPROVAL_URL: 'http://127.0.0.1:5555' })).not.toMatch(/ELECTRON_RUN_AS_NODE|WREN_APPROVAL/);
  });
});
