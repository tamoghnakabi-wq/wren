import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { userPathDirs } from './shellenv';

// macOS Seatbelt profiles (sandbox-exec) for everything an agent runs on this
// computer: shell commands, Wren's own file operations, and the Claude Code /
// Grok CLIs. The last matching rule wins, so the order matters:
//   1. writes: only the allowed folders (plus temp and toolchain caches for commands)
//   2. reads of file contents under /Users and /Volumes: only the allowed folders
//      plus the toolchains and non-secret configuration developer tools need
//      (metadata such as stat stays readable so paths still resolve)
//   3. credential files and Wren's own data: never readable, even inside (2)
// System locations (/usr, /opt/homebrew, /Library, …) stay readable to commands so tools work;
// Wren's own file helpers get only the few system files they need to start.

export type Engine = 'claude-code' | 'grok-build';

const q = (p: string) => JSON.stringify(p);
const sub = (ps: string[]) => ps.map((p) => `(subpath ${q(p)})`).join(' ');
const lit = (ps: string[]) => ps.map((p) => `(literal ${q(p)})`).join(' ');
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A path and anything starting with it (e.g. ~/.claude.json, ~/.claude.json.backup). */
const prefix = (p: string) => `(regex #"^${reEscape(p)}")`;

/** Toolchains and non-secret config that commands read (never whole config folders). */
const TOOLCHAINS = [
  '.nvm', '.volta', '.fnm', '.bun/bin', '.deno', '.cargo/bin', '.rustup', '.pyenv', '.rbenv', '.asdf', '.sdkman', 'go', '.dotnet',
  'Library/Python', '.local/bin', '.local/lib', '.local/share/uv', '.local/share/pipx', '.local/share/mise', '.local/share/pnpm',
  '.config/git', '.m2/repository', '.gradle/caches', '.gradle/wrapper',
];
const HOME_FILES = ['.gitconfig', '.gitignore_global', '.editorconfig', '.CFUserTextEncoding', '.tool-versions', '.nvmrc', '.node-version', '.python-version', '.ruby-version'];
/**
 * Package-manager caches commands may read and write. Only pnpm's store, not ~/Library/pnpm itself:
 * that is PNPM_HOME, which holds global commands and is usually first on PATH.
 */
const CACHES = [
  '.npm', '.cache', '.bun/install', '.yarn/berry', '.cargo/registry', '.cargo/git', '.nuget/packages', 'Library/pnpm/store',
  ...['pip', 'Homebrew', 'Yarn', 'node-gyp', 'ms-playwright', 'pnpm', 'go-build', 'electron', 'electron-builder', 'typescript', 'deno', 'bun', 'pypoetry', 'uv'].map((c) => `Library/Caches/${c}`),
];
/**
 * What Wren's small file helpers need to start: their own programs, the system libraries and the
 * dyld shared cache. Nothing else outside the allowed folders is readable to them (not /usr/local,
 * /Library, /etc or other system data).
 */
const HELPER_PROGRAMS = ['/bin/cat', '/bin/sh', '/bin/bash', '/bin/mkdir', '/usr/bin/dirname', '/usr/bin/find', '/usr/bin/xargs', '/usr/bin/stat', '/usr/bin/head', '/private/var/select/sh'];
const SYSTEM_RUNTIME = ['/usr/lib', '/System/Library/dyld', '/System/Volumes/Preboot/Cryptexes/OS', '/System/Cryptexes/OS', '/private/var/db/dyld', '/dev'];

/**
 * Places that make programs run later, outside any sandbox: when the user opens a terminal (shell startup
 * files and what they load), opens an editor or tmux, uses git anywhere (its global config: aliases, hooks
 * path, filters), logs in (LaunchAgents), or starts Claude Code (its settings, hooks, instructions, MCP
 * servers). No agent writes them, even when an allowed folder (the home folder) contains them; reading is
 * fine. Windows has its own: the Startup folder and PowerShell profiles.
 */
export const AUTORUN = [
  '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_login', '.bash_logout', '.profile', '.kshrc', '.mkshrc',
  '.tcshrc', '.cshrc', '.login', '.logout',
  '.oh-my-zsh', '.zsh', '.p10k.zsh', '.zinit', '.zplug', '.antigen', '.config/zsh', '.config/fish', '.config/nushell', '.config/starship.toml',
  '.tmux.conf', '.config/tmux', '.vimrc', '.vim', '.config/nvim', '.emacs', '.emacs.d', '.config/emacs',
  '.gitconfig', '.config/git',
  'Library/LaunchAgents',
  '.claude/settings.json', '.claude/settings.local.json', '.claude/CLAUDE.md', '.claude/hooks', '.claude/commands', '.claude/agents', '.claude/plugins', '.claude/skills', '.claude/output-styles', '.claude.json',
  // The engine programs Wren itself starts (Claude Code outside any sandbox): not even by their own file tools (W-182).
  '.local/share/claude', '.claude/local', '.grok/bin', '.grok/downloads',
  ...(process.platform === 'win32' ? ['AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup', 'Documents/WindowsPowerShell', 'Documents/PowerShell', '.config/powershell'] : []),
];
/**
 * AUTORUN under `home`, plus the folders on the user's PATH (a program put there runs when its name is typed).
 */
export function autorunPaths(home = homedir(), roots: string[] = []): string[] {
  const temp = tempDirs();
  const under = (p: string, r: string) => p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
  // Never a temp folder or an allowed folder itself, or one above them: that would take writing away altogether.
  const path = userPathDirs().filter((d) => d !== '/' && !temp.some((t) => under(t, d)) && !roots.some((r) => under(r, d)));
  return [...AUTORUN.map((p) => join(home, p)), ...path];
}

/** Never readable: credential stores, other apps' private data, registry/cloud tokens. */
const SECRETS = [
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.terraform.d', '.vercel', '.huggingface', '.netrc', '.git-credentials',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.gem/credentials', '.cargo/credentials', '.cargo/credentials.toml', '.nuget/NuGet',
  '.m2/settings.xml', '.m2/settings-security.xml', '.gradle/gradle.properties', '.config/gh', '.config/gcloud', '.config/op', '.config/hub',
  '.config/configstore', '.cache/huggingface/token', '.cache/huggingface/stored_tokens', '.codex', '.grok',
  'Library/Keychains', 'Library/Cookies', 'Library/Messages', 'Library/Mail', 'Library/Safari', 'Library/Application Support/Google/Chrome',
  'Library/Application Support/Firefox', 'Library/Application Support/com.vercel.cli',
];
/**
 * The CLIs' own state. Every other profile denies it. Grok Build runs inside its profile and may
 * use its state, except what would let a command change how Grok behaves later (hooks, settings,
 * trust, plugins, its own binaries), mirroring Grok's own sandbox profiles. Claude Code isn't run
 * under a profile: it runs in --restricted mode and sandboxes each command it starts instead
 * (engines/common.ts), so its Keychain sign-in and settings stay out of agent commands' reach.
 */
const ENGINE_STATE: Record<Engine, { dirs: string[]; prefixes: string[]; protect: string[] }> = {
  'claude-code': { dirs: ['.claude', '.local/share/claude', '.local/state/claude', '.cache/claude', 'Library/Caches/claude-cli-nodejs'], prefixes: ['.claude.json'], protect: [] },
  'grok-build': {
    dirs: ['.grok'],
    prefixes: [],
    // .grok/bin links to the real program in .grok/downloads (1.0.52), which the user also runs outside
    // Wren; completions are scripts their shell may load (W-178).
    protect: ['.grok/hooks', '.grok/hooks-paths', '.grok/config.toml', '.grok/trusted_folders.toml', '.grok/managed_config.toml', '.grok/requirements.toml', '.grok/sandbox.toml', '.grok/bin', '.grok/downloads', '.grok/completions', '.grok/bundled', '.grok/installed-plugins', '.grok/skills', '.grok/vendor', '.grok/marketplace-cache'],
  },
};

/** Absolute hook targets Grok loads from ~/.grok/hooks-paths (they must not be writable either). */
function grokHookTargets(home: string): string[] {
  try {
    return readFileSync(join(home, '.grok', 'hooks-paths'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/'));
  } catch {
    return [];
  }
}

interface Spec {
  roots: string[];
  dataDir: string;
  home?: string;
  /** Commands also get temp folders, toolchains and caches; Wren's own file operations don't. */
  tools: boolean;
  engine?: Engine;
  /** Extra read-only paths (e.g. this app, whose helper the engine starts): readable, never writable. */
  readOnly?: string[];
  /** Private folders in Wren's data folder this profile alone may read (an approval server's, Grok's plugin). */
  privateRead?: string[];
}

/** `p`'s parent folders from `root` down (root included), for path lookups. */
function ancestorsWithin(p: string, root: string): string[] {
  const out: string[] = [];
  const r = resolve(root);
  for (let d = dirname(resolve(p)); d === r || d.startsWith(r + '/'); d = dirname(d)) {
    out.push(d);
    if (d === r) break;
  }
  return out;
}

/**
 * Wren itself: the app (its approval helper and Grok hook among it) and its built files. No agent may
 * change them, even when an allowed folder contains them (a build inside a project, W-128): the next
 * engine run would start a rewritten helper.
 */
export function appDirs(here = __dirname): string[] {
  const dirs = [resolve(here)];
  if (process.platform === 'darwin') {
    const bundle = resolve(process.execPath, '..', '..', '..');
    if (bundle.endsWith('.app')) dirs.push(bundle); // not when run by plain Node (tests): that would be /usr or /opt
  } else dirs.push(dirname(process.execPath));
  // A development Wren (`electron .` from the repo, not packaged) also runs code from outside its build:
  // modules from the package's node_modules (playwright-core loads at the first browser use) and the start
  // file package.json names. Those are its code too (W-133).
  if (!here.includes('app.asar') && basename(here) === 'dist-electron') {
    const pkg = dirname(here);
    dirs.push(join(pkg, 'package.json'));
    for (let d = pkg; ; d = dirname(d)) {
      if (existsSync(join(d, 'node_modules'))) dirs.push(join(d, 'node_modules'));
      if (dirname(d) === d) break;
    }
    // …and the modules it loads at run time, where they really are (a linked package lives elsewhere).
    const load = createRequire(join(pkg, 'package.json'));
    for (const m of ['playwright-core', 'electron']) {
      try {
        dirs.push(dirname(load.resolve(`${m}/package.json`)));
      } catch {
        /* not installed */
      }
    }
  }
  return [...new Set(dirs.map((d) => realpathOr(d)))];
}
function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const tempDirs = () => [realpathSync(tmpdir()), '/private/tmp', '/private/var/folders'];

/**
 * Whether an agent could have changed `p` (a real path): it is writable to agent commands (every engine's
 * state off limits to them), or to Grok Build's (its own state, but not what's protected). Mirrors the
 * profiles' rules in `build`. Wren never starts a program from such a place outside a sandbox (W-178).
 */
export function agentCanWrite(p: string, roots: string[], dataDir: string, home = homedir()): boolean {
  const h = (x: string) => join(home, x);
  const fold = (x: string) => (process.platform === 'linux' ? x : x.toLowerCase());
  // As the profiles match: a folder covers itself and what's inside (never "<folder>.anything", W-181);
  // only an engine's listed file-name prefixes (~/.claude.json and its backups) match by prefix.
  const under = (list: string[]) => list.some((r) => fold(p) === fold(r) || fold(p).startsWith(fold(r.endsWith(sep) ? r : r + sep)));
  const prefixed = (list: string[]) => list.some((r) => fold(p).startsWith(fold(r)));
  const dirs = (e: Engine) => ENGINE_STATE[e].dirs.map(h);
  const prefixes = (e: Engine) => ENGINE_STATE[e].prefixes.map(h);
  const writable = agentWritable(roots, home);
  const autorun = autorunPaths(home, roots);
  const never = [...appDirs(), dataDir, ...autorun];
  // Agent commands and Wren's file helper: no engine's state is theirs.
  if (under(writable) && !under([...never, ...SECRETS.map(h), ...dirs('claude-code'), ...dirs('grok-build')]) && !prefixed([...prefixes('claude-code'), ...prefixes('grok-build')])) return true;
  // Grok Build and its commands: its own state too, except what's protected.
  const grok = ENGINE_STATE['grok-build'];
  const own = dirs('grok-build');
  if ((under([...writable, ...own]) || prefixed(prefixes('grok-build'))) && !under([...never, ...SECRETS.map(h).filter((x) => !own.includes(x)), ...dirs('claude-code'), ...grok.protect.map(h)]) && !prefixed(prefixes('claude-code'))) return true;
  // Claude Code's own file tools, outside any sandbox (W-182): the allowed folders, minus its deny rules.
  return under(roots) && !under([...enginePrivatePaths('claude-code', dataDir, home), ...autorun]);
}

/**
 * Why Wren won't start this engine program, if it won't: agents could have changed it (it, or something
 * hard-linked to it such as a pnpm store file, is somewhere they may write). Claude Code runs outside any
 * sandbox, so a rewritten program would run with the user's full access (W-178).
 */
export function untrustedProgram(path: string, roots: string[], dataDir: string): string | null {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return `${path} can't be resolved`;
  }
  if (agentCanWrite(real, roots, dataDir)) return `${real} is in a folder agents on this computer may change`;
  if (statSync(real).nlink > 1) return `${real} shares its contents with another file (a package store agents may change)`;
  return null;
}

/**
 * What an engine's own file tools must never read or write, whatever folders are allowed: Wren's data
 * folder and Wren itself, credential stores, and the other engines' state (W-177). Claude Code's
 * built-in Read/Write/Edit/Grep/Glob run in its own process, outside any profile: these go to it as
 * deny rules, and Wren's approval check refuses them too. (A file-name prefix such as ~/.claude.json
 * covers its backups as well.)
 */
export function enginePrivatePaths(engine: Engine, dataDir: string, home = homedir()): string[] {
  const h = (p: string) => join(home, p);
  const own = new Set(ENGINE_STATE[engine].dirs.map(h));
  const others = (Object.keys(ENGINE_STATE) as Engine[]).filter((e) => e !== engine).flatMap((e) => [...ENGINE_STATE[e].dirs, ...ENGINE_STATE[e].prefixes].map(h));
  const paths = [dataDir, ...appDirs(), ...SECRETS.map(h).filter((p) => !own.has(p)), ...others];
  return [...new Set(paths.flatMap((p) => [p, realpathOr(p)]))];
}

/** Everything agent shell commands may write (besides /dev): the allowed folders, temp and package caches. */
export function agentWritable(roots: string[], home = homedir()): string[] {
  return [...roots, ...tempDirs(), ...CACHES.map((p) => join(home, p))];
}

function build(s: Spec): string {
  const home = s.home ?? homedir();
  const h = (p: string) => join(home, p);
  const caches = s.tools ? CACHES.map(h) : [];
  const engine = s.engine ? ENGINE_STATE[s.engine] : { dirs: [], prefixes: [], protect: [] };
  const protect = [...engine.protect.map(h), ...(s.engine === 'grok-build' ? grokHookTargets(home) : [])];
  const engineDirs = engine.dirs.map(h);
  const enginePrefixes = engine.prefixes.map((p) => prefix(h(p))).join(' ');
  const temp = s.tools ? tempDirs() : [];
  const writable = [...s.roots, ...temp, ...caches, ...engineDirs];
  const readable = [...s.roots, ...caches, ...engineDirs, ...(s.tools ? TOOLCHAINS.map(h) : []), ...(s.readOnly ?? [])];
  const ownState = new Set(engineDirs);
  const noWrite = [...new Set([...appDirs(), ...(s.readOnly ?? []), ...autorunPaths(home, s.roots)])];
  const secrets = [...SECRETS.map(h).filter((p) => !ownState.has(p)), s.dataDir];
  const otherEngines = (Object.keys(ENGINE_STATE) as Engine[]).filter((e) => e !== s.engine);
  for (const e of otherEngines) for (const d of ENGINE_STATE[e].dirs) secrets.push(h(d));
  const secretPrefixes = otherEngines.flatMap((e) => ENGINE_STATE[e].prefixes.map((p) => prefix(h(p)))).join(' ');

  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${sub(writable)} ${enginePrefixes} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))`,
    // Commands may read system locations (toolchains live there); Wren's file helpers only the
    // allowed folders and the system runtime.
    s.tools ? `(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath ${q(home)}))` : '(deny file-read-data (subpath "/"))',
    `(allow file-read-data ${sub(readable)} ${enginePrefixes} ${s.tools ? lit(HOME_FILES.map(h)) : `${sub(SYSTEM_RUNTIME)} ${lit(HELPER_PROGRAMS)} (literal "/")`})`,
    ...(protect.length ? [`(deny file-write* ${sub(protect)} ${lit(protect)})`] : []),
    `(deny file-write* ${sub(noWrite)} ${lit(noWrite)})`,
    `(deny file-read* file-write* ${sub(secrets)} ${secretPrefixes})`,
    // Last, so it wins over the data folder's deny: read access to this profile's own private folders, and
    // to the folders above them inside the data folder for looking the path up (no listing, no contents).
    ...(s.privateRead?.length ? [`(allow file-read* ${sub(s.privateRead)})`, `(allow file-read-metadata ${lit(s.privateRead.flatMap((p) => ancestorsWithin(p, s.dataDir)))})`] : []),
  ].join('\n');
}

/** Agent shell commands (`readOnly`: extra paths they may read, e.g. this app for its helpers). */
export function seatbeltProfile(roots: string[], dataDir: string, home = homedir(), readOnly: string[] = []): string {
  return build({ roots, dataDir, home, tools: true, readOnly });
}

/**
 * Wren's approval server, which Claude Code starts through the shell prefix: a command's profile plus its
 * own private folder in Wren's data folder (bridge address and token), which commands can't read. The rule
 * comes last, so it wins over the data folder's deny (W-121).
 */
export function approvalServerProfile(roots: string[], dataDir: string, readOnly: string[], privateDir: string, home = homedir()): string {
  return build({ roots, dataDir, home, tools: true, readOnly, privateRead: [privateDir] });
}

/** Wren's own file reads/writes for the agent: the allowed folders and nothing else. */
export function fileOpsProfile(roots: string[], dataDir: string, home = homedir()): string {
  return build({ roots, dataDir, home, tools: false });
}

/** A CLI engine and everything it runs: like shell commands, plus that CLI's own state. */
export function engineProfile(engine: Engine, roots: string[], dataDir: string, readOnly: string[], home = homedir(), privateRead: string[] = []): string {
  return build({ roots, dataDir, home, tools: true, engine, readOnly, privateRead });
}

export const hasSeatbelt = () => process.platform === 'darwin' && sandboxExecExists();
let sbx: boolean | undefined;
function sandboxExecExists() {
  if (sbx === undefined) {
    try {
      realpathSync('/usr/bin/sandbox-exec');
      sbx = true;
    } catch {
      sbx = false;
    }
  }
  return sbx;
}
