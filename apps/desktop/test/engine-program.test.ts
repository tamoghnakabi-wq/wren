import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Which engine program Wren may start outside the sandbox (W-178, W-187), and that every use starts that same
// checked file (W-183). The home folder here is a scratch folder outside the temp folder (agents may write
// anything in temp), so only Wren's own rules decide.
const found = vi.hoisted(() => ({ clis: [] as string[] }));
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
vi.mock('../src/engines/common', () => ({ findClis: () => found.clis }));
vi.mock('../src/main/shellenv', async (orig) => ({ ...(await orig<typeof import('../src/main/shellenv')>()), toolEnv: async () => ({}) }));
const { checkEngineProgram, nativeProgram } = await import('../src/main/sandbox');

const scratch = realpathSync(mkdtempSync(join(__dirname, '.tmp-home-')));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const home = join(scratch, 'home');
const data = join(home, 'Library', 'Application Support', 'Wren');
const native = process.platform === 'win32' ? process.execPath : '/bin/echo'; // any real program of this platform
const put = (p: string, from?: string) => {
  mkdirSync(dirname(p), { recursive: true });
  if (from) copyFileSync(from, p);
  else writeFileSync(p, '#!/bin/sh\nexit 0\n');
  chmodSync(p, 0o755);
  return p;
};
const check = (p: string, roots: string[] = [home]) => checkEngineProgram('claude-code', p, roots, data, home);

describe('the engine program Wren starts outside the sandbox', () => {
  it("starts Claude Code's own install, as its real file, even with the whole home folder allowed (W-182)", () => {
    const real = put(join(home, '.local/share/claude/versions/9.9.9'), native);
    const link = join(home, '.local/bin/claude');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(real, link);
    expect(check(link)).toEqual({ program: realpathSync(real) });
    expect(check(link, [])).toEqual({ program: realpathSync(real) });
  });

  it('refuses a launcher that runs code from somewhere agents may write, even in a folder they may not (W-187)', () => {
    // Unchanged and in a protected PATH folder, but what it runs is in the allowed home folder.
    const runtime = put(join(home, '.local/lib/wren-claude/runtime.cjs'));
    const launcher = join(home, '.local/bin/claude-wrapper');
    writeFileSync(launcher, `#!/bin/sh\nexec node ${runtime} "$@"\n`, { mode: 0o755 });
    expect(check(launcher)).toMatchObject({ why: expect.stringMatching(/isn't where Claude Code's own installer puts it/) });
    // A native shim (a version manager's) is just as much a launcher for code elsewhere.
    expect(check(put(join(home, '.volta/bin/claude'), native))).toMatchObject({ why: expect.stringMatching(/own installer/) });
    // An npm install, in or outside the allowed folders.
    expect(check(put(join(home, '.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js')))).toMatchObject({ why: expect.stringMatching(/own installer/) });
  });

  it('refuses a script, or a file shared with another, even where the installer puts the program (W-178)', () => {
    expect(check(put(join(home, '.local/share/claude/versions/9.9.8')))).toMatchObject({ why: expect.stringMatching(/is a script/) });
    const shared = put(join(home, '.local/share/claude/versions/9.9.7'), native);
    linkSync(shared, join(scratch, 'store-copy'));
    expect(check(shared)).toMatchObject({ why: expect.stringMatching(/shares its contents/) });
    expect(check(join(home, '.local/share/claude/versions/missing'))).toMatchObject({ why: expect.stringMatching(/can't be resolved/) });
  });

  it("matches Grok Build's install folders, and not another engine's", () => {
    const grok = put(join(home, '.grok/downloads/grok-9.9.9'), native);
    expect(checkEngineProgram('grok-build', grok, [home], data, home)).toEqual({ program: realpathSync(grok) });
    expect(checkEngineProgram('claude-code', grok, [home], data, home)).toMatchObject({ why: expect.stringMatching(/own installer/) });
  });

  it('tells native programs from scripts', () => {
    expect(nativeProgram(native)).toBe(true);
    expect(nativeProgram(put(join(scratch, 'script')))).toBe(false);
    expect(nativeProgram(join(scratch, 'missing'))).toBe(false);
  });

  it.skipIf(!existsSync(join(homedir(), '.local/share/claude/versions')))('accepts the Claude Code installed on this computer', () => {
    const r = checkEngineProgram('claude-code', join(homedir(), '.local/bin/claude'), [homedir()], join(homedir(), 'Library/Application Support/Wren'));
    expect(r).toEqual({ program: realpathSync(join(homedir(), '.local/bin/claude')) });
  });

  it.skipIf(!existsSync(join(homedir(), '.grok/bin/grok')))('accepts the Grok Build installed on this computer', () => {
    const r = checkEngineProgram('grok-build', join(homedir(), '.grok/bin/grok'), [homedir()], join(homedir(), 'Library/Application Support/Wren'));
    expect(r).toEqual({ program: realpathSync(join(homedir(), '.grok/bin/grok')) });
  });
});

describe('engineProgram: the one program every use starts (W-183)', () => {
  const saved = process.env.HOME;
  beforeEach(() => {
    process.env.HOME = home; // homedir() follows it
    process.env.WREN_DATA_DIR = data;
    return () => void (process.env.HOME = saved);
  });

  it('takes the first copy found that passes, skipping one agents could have planted earlier on the way', async () => {
    const { engineProgram } = await import('../src/engines/program');
    const planted = put(join(home, 'Projects/bin/claude')); // an allowed folder, first in the lookup order
    const real = put(join(home, '.local/share/claude/versions/9.9.9'), native);
    found.clis = [planted, real];
    expect(await engineProgram('claude-code', [join(home, 'Projects')])).toEqual({ program: realpathSync(real) });
    found.clis = [planted];
    expect(await engineProgram('claude-code', [join(home, 'Projects')])).toMatchObject({ untrusted: expect.stringContaining(planted) });
    found.clis = [];
    expect(await engineProgram('claude-code', [])).toBeNull();
  });
});

describe('the sign-in script Terminal runs (W-183)', () => {
  it('starts the checked program by its full path, quoted, never a name Terminal looks up again', async () => {
    const { engineLoginScript } = await import('../src/main/login');
    const dir = join(scratch, "it's here");
    const program = join(dir, 'grok');
    mkdirSync(dir, { recursive: true });
    writeFileSync(program, `#!/bin/sh\necho "ran $0 $*" > ${JSON.stringify(join(scratch, 'ran.txt'))}\n`, { mode: 0o755 });
    const { file } = engineLoginScript(join(scratch, 'data'), 'grok-build', program);
    const script = readFileSync(file, 'utf8');
    expect(script).not.toMatch(/^grok login$/m);
    expect(script).toContain(`'${scratch}/it'\\''s here/grok' login`);
    if (process.platform !== 'win32') {
      // With a PATH that has its own "grok" first, the script still runs the checked one.
      put(join(scratch, 'decoy/grok'));
      expect(spawnSync('/bin/bash', [file], { env: { PATH: `${join(scratch, 'decoy')}:/usr/bin:/bin` } }).status).toBe(0);
      expect(readFileSync(join(scratch, 'ran.txt'), 'utf8').trim()).toBe(`ran ${program} login`);
    }
  });
});
