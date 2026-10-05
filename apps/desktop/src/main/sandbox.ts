import { readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// macOS Seatbelt profiles (sandbox-exec) for everything an agent runs on this
// computer: shell commands, Wren's own file operations, and the Claude Code /
// Grok CLIs. The last matching rule wins, so the order matters:
//   1. writes: only the allowed folders (plus temp and toolchain caches for commands)
//   2. reads of file contents under /Users and /Volumes: only the allowed folders
//      plus the toolchains and non-secret configuration developer tools need
//      (metadata such as stat stays readable so paths still resolve)
//   3. credential files and Wren's own data: never readable, even inside (2)
// System locations (/usr, /opt/homebrew, /Library, …) stay readable so tools work.

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
/** Package-manager caches commands may read and write. */
const CACHES = [
  '.npm', '.cache', '.bun/install', '.yarn/berry', '.cargo/registry', '.cargo/git', '.nuget/packages', 'Library/pnpm',
  ...['pip', 'Homebrew', 'Yarn', 'node-gyp', 'ms-playwright', 'pnpm', 'go-build', 'electron', 'electron-builder', 'typescript', 'deno', 'bun', 'pypoetry', 'uv'].map((c) => `Library/Caches/${c}`),
];
/** What the small file helpers (cat, sh, find, stat) need to load; everything else is unreadable to them. */
const SYSTEM_RUNTIME = ['/usr', '/bin', '/sbin', '/System', '/private/var/db/dyld', '/private/var/db/timezone', '/dev', '/Library/Apple'];

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
    protect: ['.grok/hooks', '.grok/hooks-paths', '.grok/config.toml', '.grok/trusted_folders.toml', '.grok/managed_config.toml', '.grok/requirements.toml', '.grok/sandbox.toml', '.grok/bin', '.grok/bundled', '.grok/installed-plugins', '.grok/skills', '.grok/vendor', '.grok/marketplace-cache'],
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
  /** Extra read-only paths (e.g. this app, whose helper the engine starts). */
  readOnly?: string[];
}

function build(s: Spec): string {
  const home = s.home ?? homedir();
  const h = (p: string) => join(home, p);
  const caches = s.tools ? CACHES.map(h) : [];
  const engine = s.engine ? ENGINE_STATE[s.engine] : { dirs: [], prefixes: [], protect: [] };
  const protect = [...engine.protect.map(h), ...(s.engine === 'grok-build' ? grokHookTargets(home) : [])];
  const engineDirs = engine.dirs.map(h);
  const enginePrefixes = engine.prefixes.map((p) => prefix(h(p))).join(' ');
  const temp = s.tools ? [realpathSync(tmpdir()), '/private/tmp', '/private/var/folders'] : [];
  const writable = [...s.roots, ...temp, ...caches, ...engineDirs];
  const readable = [...s.roots, ...caches, ...engineDirs, ...(s.tools ? TOOLCHAINS.map(h) : []), ...(s.readOnly ?? [])];
  const ownState = new Set(engineDirs);
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
    `(allow file-read-data ${sub(readable)} ${enginePrefixes} ${s.tools ? lit(HOME_FILES.map(h)) : `${sub(SYSTEM_RUNTIME)} (literal "/")`})`,
    ...(protect.length ? [`(deny file-write* ${sub(protect)} ${lit(protect)})`] : []),
    `(deny file-read* file-write* ${sub(secrets)} ${secretPrefixes})`,
  ].join('\n');
}

/** Agent shell commands (`readOnly`: extra paths they may read, e.g. this app for its helpers). */
export function seatbeltProfile(roots: string[], dataDir: string, home = homedir(), readOnly: string[] = []): string {
  return build({ roots, dataDir, home, tools: true, readOnly });
}

/** Wren's own file reads/writes for the agent: the allowed folders and nothing else. */
export function fileOpsProfile(roots: string[], dataDir: string, home = homedir()): string {
  return build({ roots, dataDir, home, tools: false });
}

/** A CLI engine and everything it runs: like shell commands, plus that CLI's own state. */
export function engineProfile(engine: Engine, roots: string[], dataDir: string, readOnly: string[], home = homedir()): string {
  return build({ roots, dataDir, home, tools: true, engine, readOnly });
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
