import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';

// The environment agent commands run with. Sandboxed commands can't read shell
// startup files (they often export tokens), so instead the user's shell is
// asked once, outside the sandbox, for its PATH and a few toolchain variables.
// Only those reach agent commands; nothing else from the startup files does.

/** Toolchain variables taken from the user's login shell (macOS). */
export const TOOL_VAR_NAMES = ['PATH', 'JAVA_HOME', 'GOPATH', 'GOROOT', 'NVM_DIR', 'NVM_BIN', 'PYENV_ROOT', 'RBENV_ROOT', 'CARGO_HOME', 'RUSTUP_HOME', 'BUN_INSTALL', 'PNPM_HOME', 'VOLTA_HOME', 'DENO_INSTALL', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_REPOSITORY', 'LANG', 'LC_ALL', 'LC_CTYPE'];
const TOOL_VARS = new RegExp(`^(${TOOL_VAR_NAMES.join('|')})$`);

/**
 * The only variables agent commands get from Wren's own environment (W-108). Wren may have been
 * started from a terminal that exported tokens (GH_TOKEN, AWS_*), startup hooks (BASH_ENV, ENV),
 * loader settings (DYLD_*, NODE_OPTIONS) or programs to run (PAGER, LESSOPEN): none of that is
 * passed on. On Windows, also what Windows itself needs to run programs.
 */
export const BASE_VAR_NAMES = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'TZ', '__CF_USER_TEXT_ENCODING'];
const WINDOWS_VAR_NAMES = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)',
  'CommonProgramW6432', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS', 'COMPUTERNAME', 'DriverData', 'PUBLIC', 'ALLUSERSPROFILE',
  'PSModulePath',
];

/** The environment an agent command runs with: the allowlisted variables of `base`, then `tool`. */
export function agentEnv(base: NodeJS.ProcessEnv, tool: Record<string, string>, platform = process.platform): NodeJS.ProcessEnv {
  // On Windows the toolchain variables (JAVA_HOME, …) are system settings, not shell exports.
  const names = platform === 'win32' ? [...BASE_VAR_NAMES, ...WINDOWS_VAR_NAMES, ...TOOL_VAR_NAMES, 'Path'] : [...BASE_VAR_NAMES, ...TOOL_VAR_NAMES];
  const wanted = new Set(names.map((n) => (platform === 'win32' ? n.toLowerCase() : n)));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && wanted.has(platform === 'win32' ? k.toLowerCase() : k)) env[k] = v;
  if (platform === 'win32') {
    // Programs are only looked up in absolute PATH folders, never relative to the project.
    for (const k of Object.keys(env)) if (/^path$/i.test(k)) env[k] = absolutePath(env[k] ?? '', platform);
  } else if (env.PATH !== undefined) env.PATH = absolutePath(env.PATH, platform);
  for (const [k, v] of Object.entries(tool)) {
    // Windows names are case-insensitive: replace "Path" rather than add a second "PATH".
    const same = platform === 'win32' ? Object.keys(env).find((e) => e.toLowerCase() === k.toLowerCase()) : undefined;
    if (same && same !== k) delete env[same];
    env[k] = v;
  }
  env.WREN_AGENT = '1';
  return env;
}

const fallbackPath = () => [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

let cached: Promise<Record<string, string>> | null = null;

/** Only absolute PATH entries: "", "." or "bin" would look up programs in whatever folder a command runs in. */
export function absolutePath(path: string, platform = process.platform): string {
  const sep = platform === 'win32' ? ';' : ':';
  const abs = platform === 'win32' ? (d: string) => win32.isAbsolute(d) && /^([a-zA-Z]:\\|\\\\)/.test(d) : (d: string) => isAbsolute(d);
  return path.split(sep).filter((d) => d && abs(d)).join(sep);
}

/** PATH and toolchain variables from the user's login shell (macOS), resolved once. */
export function toolEnv(): Promise<Record<string, string>> {
  cached ??= new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve({ PATH: absolutePath(process.env.PATH ?? '') });
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
      if (env.PATH !== undefined) env.PATH = absolutePath(env.PATH);
      if (!env.PATH?.includes('/usr/bin')) return resolve(fallback);
      // Keep the usual locations even if the shell's PATH left some out.
      const seen = new Set(env.PATH.split(':'));
      env.PATH = [env.PATH, ...fallback.PATH.split(':').filter((d) => !seen.has(d))].join(':');
      resolve(env);
    });
  });
  return cached;
}

// Claude Code's documented CLAUDE_CODE_SHELL_PREFIX runs `<prefix> "<command>"` for every shell
// command (and MCP server) it starts. Wren's prefix runs that command inside the shell sandbox.
// It lives in Wren's data folder, which sandboxed commands can neither read nor change.
// The command also gets only the agent allowlist of variables (W-108): Claude Code's own sign-in
// and provider settings stay with Claude Code.
const PREFIX_VARS = [...BASE_VAR_NAMES, ...TOOL_VAR_NAMES].filter((n) => n !== 'SHELL');
export const SHELL_PREFIX = `#!/bin/sh
# Written by Wren: runs one command from Claude Code inside Wren's sandbox, with a minimal environment.
p="$WREN_SHELL_SB"
unset WREN_SHELL_SB
[ -n "$p" ] || { echo "Wren: sandbox profile missing, so the command was not run." >&2; exit 126; }
case "$SHELL" in /bin/zsh|/bin/bash) sh="$SHELL" ;; *) sh=/bin/zsh ;; esac
cmd="$1"
set --
for v in ${PREFIX_VARS.join(' ')}; do
  eval "isset=\\\${$v+1}; val=\\\${$v-}"
  [ -n "$isset" ] && set -- "$@" "$v=$val"
done
exec /usr/bin/env -i "$@" SHELL="$sh" WREN_AGENT=1 /usr/bin/sandbox-exec -p "$p" "$sh" -c "$cmd"
`;
