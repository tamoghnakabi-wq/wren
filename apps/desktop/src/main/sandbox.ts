import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, unlinkSync, type Dirent } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
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
  // ~/.local/bin is where Claude Code's installer puts its command (on Windows, the program itself, W-187).
  '.local/share/claude', '.claude/local', '.grok/bin', '.grok/downloads', '.local/bin',
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
/** Where the same kinds of sign-ins live on Windows (no profile there: Wren's own checks are all there is, A-D4). */
const WINDOWS_SECRETS = [
  'AppData/Roaming/GitHub CLI', 'AppData/Roaming/Microsoft/Credentials', 'AppData/Local/Microsoft/Credentials', 'AppData/Roaming/Microsoft/Protect',
  'AppData/Local/Google/Chrome/User Data', 'AppData/Local/Microsoft/Edge/User Data', 'AppData/Roaming/Mozilla/Firefox', 'AppData/Roaming/com.vercel.cli',
  'AppData/Roaming/gcloud', 'AppData/Roaming/npm-cache/_cacache/index-v5', 'AppData/Roaming/NuGet/NuGet.Config',
];
const secretsHere = () => (process.platform === 'win32' ? [...SECRETS, ...WINDOWS_SECRETS] : SECRETS);
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
 * Where each engine's own installer puts its program: one native file that is the whole program, in a folder
 * no agent may write (AUTORUN). Elsewhere (an npm or version-manager install, a wrapper or shim) the file Wren
 * can check isn't all that runs: the interpreter, modules or runtime it loads can be anywhere, also where
 * agents may write (W-187). Homebrew's casks live outside the home folder, so `agentCanWrite` decides those.
 */
const ENGINE_INSTALLS: Record<Engine, { home: string[]; system: string[] }> = {
  'claude-code': {
    home: ['.local/share/claude/versions', ...(process.platform === 'win32' ? ['.local/bin'] : [])],
    system: ['/opt/homebrew/Caskroom/claude-code', '/usr/local/Caskroom/claude-code'],
  },
  'grok-build': { home: ['.grok/downloads', '.grok/bin'], system: [] },
};
const ENGINE_NAMES: Record<Engine, string> = { 'claude-code': 'Claude Code', 'grok-build': 'Grok Build' };

/** A native program for this platform (Mach-O, PE or ELF), not a script that has an interpreter run it. */
export function nativeProgram(real: string, platform = process.platform): boolean {
  const b = Buffer.alloc(4);
  let fd: number | undefined;
  try {
    fd = openSync(real, 'r');
    if (readSync(fd, b, 0, 4, 0) < 4) return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (platform === 'win32') return b[0] === 0x4d && b[1] === 0x5a; // MZ
  if (platform === 'darwin') return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf, 0xbebafeca].includes(b.readUInt32BE(0));
  return b.readUInt32BE(0) === 0x7f454c46; // ELF
}

/**
 * Whether Wren may start this engine program outside a sandbox (Claude Code runs outside any, and a
 * rewritten program would run with the user's full access), and if so its real file, which is what every
 * caller then starts: the version and --help probes, a run and sign-in (W-183). It must be a native program
 * where the engine's own installer puts it (W-187), in no folder an agent may write, and not hard-linked to
 * another file such as a package store's (W-178).
 */
export function checkEngineProgram(engine: Engine, path: string, roots: string[], dataDir: string, home = homedir()): { program: string } | { why: string } {
  return checkInstalledProgram(ENGINE_INSTALLS[engine], ENGINE_NAMES[engine], path, roots, dataDir, home);
}

/**
 * Codex, which Wren runs only to ask its plan's limits (Usage → This Mac): its standalone installer's native
 * program, or Homebrew's cask, checked as an engine's is (it runs outside any sandbox too).
 */
const CODEX_INSTALLS = { home: ['.codex/packages/standalone'], system: ['/opt/homebrew/Caskroom/codex', '/usr/local/Caskroom/codex'] };
export function checkCodexProgram(path: string, roots: string[], dataDir: string, home = homedir()): { program: string } | { why: string } {
  return checkInstalledProgram(CODEX_INSTALLS, 'Codex', path, roots, dataDir, home);
}

function checkInstalledProgram(where: { home: string[]; system: string[] }, label: string, path: string, roots: string[], dataDir: string, home: string): { program: string } | { why: string } {
  let real: string;
  try {
    real = realpathSync.native(path); // on macOS and Windows, the name as stored (case included)
  } catch {
    return { why: `${path} can't be resolved` };
  }
  // Exact names on macOS: on a case-sensitive volume another case would be another, unprotected folder.
  const same = (x: string) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const { home: inHome, system } = where;
  const installs = [...inHome.map((p) => join(home, p)), ...system].map((p) => {
    try {
      return realpathSync.native(p);
    } catch {
      return p;
    }
  });
  if (!installs.some((d) => same(real).startsWith(same(d.endsWith(sep) ? d : d + sep)))) return { why: `${real} isn't where ${label}'s own installer puts it, so Wren can't tell what else it runs (an npm or version-manager install loads code from other places)` };
  if (agentCanWrite(real, roots, dataDir, home)) return { why: `${real} is in a folder agents on this computer may change` };
  const st = statSync(real);
  if (!st.isFile()) return { why: `${real} isn't a program file` };
  if (st.nlink > 1) return { why: `${real} shares its contents with another file (a package store agents may change)` };
  if (!nativeProgram(real)) return { why: `${real} is a script, not the program itself` };
  return { program: real };
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
  const paths = [dataDir, ...appDirs(), ...secretsHere().map(h).filter((p) => !own.has(p)), ...others];
  return [...new Set(paths.flatMap((p) => [p, realpathOr(p)]))];
}

/**
 * Every credential store and every engine's state (~/.ssh, ~/.aws, ~/.npmrc, ~/.config/gh, ~/.claude, ~/.grok…):
 * what Wren's own file tools never read, write or list. The file helper's profile denies the same on macOS;
 * on Windows this list is all there is (A-D4, 0.1.50).
 */
export function credentialStores(home = homedir()): string[] {
  const h = (p: string) => join(home, p);
  const all = [...secretsHere(), ...Object.values(ENGINE_STATE).flatMap((e) => [...e.dirs, ...e.prefixes])].map(h);
  return [...new Set(all.flatMap((p) => [p, realpathOr(p)]))];
}

// ------------------------------------------------------------------ unix sockets
//
// A unix socket is a door into whatever program listens on it, and the program runs outside the profile:
// Docker's (a container can mount the whole home folder), tmux's (`send-keys` runs commands), an editor's
// or a browser's (open, run), Claude Code's own sessions. Commands may only connect to sockets in the allowed
// folders, their own temp area and the default database sockets (the same servers answer on loopback TCP).
// A path rule alone isn't enough: a command could move or hard-link another program's socket (or the folder
// holding it) to where it may connect (tested), so those moves are refused too (0.1.50 review).

/** Where agent commands' own temporary files and sockets go: each run gets a folder here as TMPDIR. */
export function agentTempRoot(): string {
  return join(realpathOr(tmpdir()), 'wren-a');
}

/**
 * A run's own temp folder (its commands' TMPDIR and TMUX_TMPDIR). Short: a socket's path may be at most 104
 * bytes on macOS, and this one is about 74, which leaves room for a tool's own folder and socket name.
 */
export function runTempDir(runId: string): string {
  return join(agentTempRoot(), createHash('sha256').update(runId).digest('hex').slice(0, 10));
}

/**
 * Make a run's temp folder, and the area itself if needed. Agents may write the temp folder, so whatever is at
 * the area's name and isn't a real folder (a link somewhere else) is removed first; sockets are matched by
 * their real path anyway, so a link could never widen what's reachable.
 */
export function makeRunTemp(runId: string): string {
  const root = agentTempRoot();
  const dir = runTempDir(runId);
  // Agents may replace either with a link (the area is in their temp folder): Wren's own process writes there (the
  // Docker broker's socket), so a link is removed and the folder made again (2026-11-26 audit).
  for (const p of [root, dir]) {
    try {
      if (!lstatSync(p).isDirectory()) unlinkSync(p);
    } catch {
      // nothing there yet
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * The Docker CLI's config for agents (DOCKER_CONFIG): readable to commands, writable by none (in every profile's
 * `noWrite`), so Wren never writes a file where an agent could have put a link (2026-11-26 audit).
 */
export function dockerConfigDir(): string {
  return join(realpathOr(tmpdir()), 'wren-docker-cli');
}

/** Remove a finished run's temp folder (best effort). */
export function removeRunTemp(runId: string): void {
  try {
    rmSync(runTempDir(runId), { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // left for the next start's clean-up
  }
}

/** At start: whatever runs that ended without cleaning up left in the area. */
export function clearAgentTemp(): void {
  try {
    rmSync(agentTempRoot(), { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // best effort
  }
}

/** Where other programs keep sockets: no command may connect there, except in the places below. */
const SOCKET_ZONES = ['/Users', '/Volumes', '/private/tmp', '/private/var/folders', '/private/var/tmp'];
/** The default PostgreSQL and MySQL sockets (the same servers answer on loopback TCP). */
const DB_SOCKETS = [String.raw`(regex #"^/private/tmp/\.s\.PGSQL\.[0-9]+$")`, String.raw`(regex #"^/private/tmp/mysqlx?\.sock$")`];
/**
 * Folders well-known programs keep their sockets in, in the temp folders: tmux, Chromium and Electron apps'
 * single-instance sockets, reverse-DNS app folders, editors' servers, Podman, X11. Covers ones made after a
 * profile was built; `socketHolders` covers whatever exists when it's built.
 */
const SOCKET_FAMILIES = String.raw`(tmux-[0-9]+|cc-socks|scoped_dir[^/]*|\.com\.google\.Chrome\.[^/]*|\.org\.chromium\.[^/]*|com\.[^/]+\.[^/]+|t3[^/]*|nvim[^/]*|emacs[^/]*|vscode[^/]*|podman[^/]*|containers[^/]*|\.X11-unix|\.ICE-unix)`;

let holders: { at: number; dirs: string[] } | undefined;
/**
 * The folders (from the temp folder down) that hold a socket of a program running now, at most three levels
 * deep: none of them may be moved or removed from inside a profile, or the socket could be carried to where
 * connecting is allowed. Read again at most every 5 s (a profile is built for every command).
 */
export function socketHolders(now = Date.now()): string[] {
  if (holders && now - holders.at < 5000) return holders.dirs;
  const area = agentTempRoot();
  const out = new Set<string>();
  let budget = 20_000;
  const walk = (dir: string, depth: number, chain: string[]) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (--budget < 0) return;
      const p = join(dir, e.name);
      if (p === area) continue;
      if (e.isSocket()) for (const c of chain) out.add(c);
      else if (e.isDirectory() && depth < 3) walk(p, depth + 1, [...chain, p]);
    }
  };
  for (const root of new Set([realpathOr(tmpdir()), '/private/tmp'])) walk(root, 0, []);
  holders = { at: now, dirs: [...out] };
  return holders.dirs;
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
  const noWrite = [...new Set([...appDirs(), ...(s.readOnly ?? []), ...autorunPaths(home, s.roots), dockerConfigDir()])];
  const secrets = [...SECRETS.map(h).filter((p) => !ownState.has(p)), s.dataDir];
  const otherEngines = (Object.keys(ENGINE_STATE) as Engine[]).filter((e) => e !== s.engine);
  for (const e of otherEngines) for (const d of ENGINE_STATE[e].dirs) secrets.push(h(d));
  const secretPrefixes = otherEngines.flatMap((e) => ENGINE_STATE[e].prefixes.map((p) => prefix(h(p)))).join(' ');
  // Unix sockets (see "unix sockets" above). Each path is its own `(remote unix-socket …)`: given several,
  // Seatbelt reads only the first (tested), so 0.1.50's first version refused nothing under /Volumes and
  // allowed sockets in the first allowed folder only.
  const socket = (filters: string[]) => `(require-any ${filters.map((f) => `(remote unix-socket ${f})`).join(' ')})`;
  const any = (filters: string[]) => (filters.length ? `(require-any ${filters.join(' ')})` : '(require-any (literal "/dev/null/none"))');
  const area = agentTempRoot();
  // The Library folder and the home folder's dot-folders are where apps keep theirs (Docker, Colima, OrbStack,
  // Lima, 1Password, VS Code); an allowed folder inside one (an iCloud Drive project) is still the user's.
  const homeZones = [`(subpath ${q(h('Library'))})`, `(regex #"^${reEscape(home)}/\\.")`];
  const inHomeZones = (p: string) => p.startsWith(h('Library') + sep) || p.startsWith(home + sep + '.');
  const rootsInZones = s.roots.filter(inHomeZones);
  const rootsOutside = s.roots.filter((p) => !inHomeZones(p));
  const reachable = [...rootsOutside, ...rootsInZones, area, ...engineDirs].map((p) => `(subpath ${q(p)})`);
  const sockets = [
    `(deny network-outbound ${socket(SOCKET_ZONES.map((z) => `(subpath ${q(z)})`))})`,
    `(allow network-outbound ${socket([...rootsOutside, area].map((p) => `(subpath ${q(p)})`).concat(s.tools ? DB_SOCKETS : []))})`,
    `(deny network-outbound ${socket(homeZones)})`,
    ...(rootsInZones.length || engineDirs.length ? [`(allow network-outbound ${socket([...rootsInZones, ...engineDirs].map((p) => `(subpath ${q(p)})`))})`] : []),
  ];
  // …and nothing may be carried to where it could be reached: no hard link to a socket; no socket moved (or
  // removed) from a place where it can't be reached; no folder holding another program's socket moved or
  // removed from the temp folders; and, where the home folder itself is allowed, no folder in Library or a
  // dot-folder moved or removed (package caches and the allowed folders inside them aside).
  const tempRoots = [realpathOr(tmpdir()), '/private/tmp'].map(reEscape).join('|');
  const moves = [
    '(deny file-link (vnode-type SOCKET))',
    `(deny file-write-unlink (require-all (vnode-type SOCKET) (require-not ${any(reachable)})))`,
    `(deny file-write-unlink (require-all (vnode-type DIRECTORY) ${any([...socketHolders().map((p) => `(literal ${q(p)})`), `(regex #"^(${tempRoots})/${SOCKET_FAMILIES}(/|$)")`])}))`,
    `(deny file-write-unlink (require-all (vnode-type DIRECTORY) ${any(homeZones)} (require-not ${any([...CACHES.map(h), ...engineDirs, ...rootsInZones].map((p) => `(subpath ${q(p)})`))})))`,
  ];

  return [
    '(version 1)',
    '(allow default)',
    // What runs here can't start anything outside it: LaunchServices (`open`) and launchd start apps and
    // helpers with the user's full access, and Apple Events tell apps already running (Terminal, Finder) to
    // run commands (A-D2, 0.1.50). launchctl submit/bootstrap are already refused inside a profile.
    '(deny lsopen)',
    '(deny appleevent-send)',
    // System services that act for a command outside its own process (2026-11-26 audit, each tested from inside a
    // profile): the clipboard (it read whatever the user had copied: a password, a code), the screen through
    // ScreenCaptureKit (with Wren's own Screen Recording permission, past the screen switch and its approval), and
    // the user's Shortcuts (they run outside the sandbox, with input the command chooses). Automator refuses
    // sandboxed callers itself.
    String.raw`(deny mach-lookup (global-name-regex #"^com\.apple\.(pasteboard\.|replayd$|siri\.VoiceShortcuts|shortcuts\.|WorkflowKit\.)"))`,
    // Sockets are matched by their real path, so a link elsewhere (/var/run/docker.sock) is covered too.
    ...sockets,
    '(deny file-write*)',
    `(allow file-write* ${sub(writable)} ${enginePrefixes} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))`,
    // Commands may read system locations (toolchains live there); Wren's file helpers only the
    // allowed folders and the system runtime.
    s.tools ? `(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath ${q(home)}))` : '(deny file-read-data (subpath "/"))',
    `(allow file-read-data ${sub(readable)} ${enginePrefixes} ${s.tools ? lit(HOME_FILES.map(h)) : `${sub(SYSTEM_RUNTIME)} ${lit(HELPER_PROGRAMS)} (literal "/")`})`,
    ...(protect.length ? [`(deny file-write* ${sub(protect)} ${lit(protect)})`] : []),
    `(deny file-write* ${sub(noWrite)} ${lit(noWrite)})`,
    ...moves,
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
