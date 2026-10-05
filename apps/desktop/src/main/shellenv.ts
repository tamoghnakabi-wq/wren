import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The environment agent commands run with. Sandboxed commands can't read shell
// startup files (they often export tokens), so instead the user's shell is
// asked once, outside the sandbox, for its PATH and a few toolchain variables.
// Only those reach agent commands; nothing else from the startup files does.

const TOOL_VARS = /^(PATH|JAVA_HOME|GOPATH|GOROOT|NVM_DIR|NVM_BIN|PYENV_ROOT|RBENV_ROOT|CARGO_HOME|RUSTUP_HOME|BUN_INSTALL|PNPM_HOME|VOLTA_HOME|DENO_INSTALL|ANDROID_HOME|ANDROID_SDK_ROOT|HOMEBREW_PREFIX|HOMEBREW_CELLAR|HOMEBREW_REPOSITORY|LANG|LC_ALL|LC_CTYPE)$/;

const fallbackPath = () => [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

let cached: Promise<Record<string, string>> | null = null;

/** PATH and toolchain variables from the user's login shell (macOS), resolved once. */
export function toolEnv(): Promise<Record<string, string>> {
  cached ??= new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve({ PATH: process.env.PATH ?? '' });
    const fallback = { PATH: fallbackPath() };
    const sh = /^\/(bin|usr\/local\/bin|opt\/homebrew\/bin)\/(zsh|bash)$/.test(process.env.SHELL ?? '') ? process.env.SHELL! : '/bin/zsh';
    const p = spawn(sh, ['-ilc', 'printf "\\n__WREN_ENV_START__\\n"; /usr/bin/env; printf "\\n__WREN_ENV_END__\\n"'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { HOME: homedir(), USER: process.env.USER ?? '', LOGNAME: process.env.LOGNAME ?? process.env.USER ?? '', SHELL: sh, PATH: fallback.PATH, TERM: 'dumb' },
      timeout: 10_000,
    });
    let out = '';
    p.stdout.on('data', (c) => (out = (out + c).slice(-200_000)));
    p.on('error', () => resolve(fallback));
    p.on('close', () => {
      const block = /__WREN_ENV_START__\n([\s\S]*)\n__WREN_ENV_END__/.exec(out)?.[1] ?? '';
      const env: Record<string, string> = {};
      for (const line of block.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0 && TOOL_VARS.test(line.slice(0, i))) env[line.slice(0, i)] = line.slice(i + 1);
      }
      if (!env.PATH?.includes('/usr/bin')) return resolve(fallback);
      // Keep the usual locations even if the shell's PATH left some out.
      const seen = new Set(env.PATH.split(':'));
      env.PATH = [env.PATH, ...fallback.PATH.split(':').filter((d) => !seen.has(d))].join(':');
      resolve(env);
    });
  });
  return cached;
}
