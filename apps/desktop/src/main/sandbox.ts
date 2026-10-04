import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// macOS Seatbelt profile for agent shell commands (sandbox-exec). The last
// matching rule wins, so the order matters:
//   1. writes: only the allowed folders, temp and package-manager caches
//   2. reads of file contents in the home folder: only the allowed folders plus
//      the dotfiles, toolchains and caches developer tools need (metadata such
//      as stat stays readable so paths still resolve)
//   3. credential stores and Wren's own data: never readable, even inside (2)

export function seatbeltProfile(roots: string[], dataDir: string, home = homedir()): string {
  const q = (p: string) => JSON.stringify(p);
  const sub = (ps: string[]) => ps.map((p) => `(subpath ${q(p)})`).join(' ');
  const lit = (ps: string[]) => ps.map((p) => `(literal ${q(p)})`).join(' ');
  const h = (...p: string[]) => join(home, ...p);

  const caches = [h('.npm'), h('.cache'), h('Library/Caches'), h('.cargo/registry'), h('.bun/install'), h('Library/pnpm'), h('.yarn')];
  const writable = [...roots, realpathSync(tmpdir()), '/private/tmp', '/private/var/folders', ...caches];
  const homeReadable = [
    ...roots,
    ...caches,
    ...['.config', '.local', '.nvm', '.volta', '.fnm', '.bun', '.deno', '.cargo', '.rustup', '.pyenv', '.rbenv', '.asdf', '.sdkman', 'go', '.gradle', '.m2', '.dotnet', '.nuget', 'Library/Python'].map((d) => h(d)),
  ];
  const homeFiles = ['.bash_profile', '.bashrc', '.profile', '.bash_login', '.inputrc', '.zshrc', '.zprofile', '.zshenv', '.gitconfig', '.gitignore_global', '.npmrc', '.yarnrc', '.yarnrc.yml', '.editorconfig', '.CFUserTextEncoding', '.tool-versions'].map((f) => h(f));
  const secret = [h('.ssh'), h('.aws'), h('.gnupg'), h('.kube'), h('.docker'), h('.netrc'), h('.config/gh'), h('.config/gcloud'), h('.config/op'), h('Library/Keychains'), h('Library/Cookies'), h('Library/Messages'), h('Library/Mail'), h('Library/Application Support/Google/Chrome'), h('Library/Application Support/Firefox'), h('Library/Safari'), h('.codex'), h('.claude'), h('.claude.json'), h('.grok'), dataDir];

  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${sub(writable)} (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))`,
    `(deny file-read-data (subpath ${q(home)}))`,
    `(allow file-read-data ${sub(homeReadable)} ${lit(homeFiles)})`,
    `(deny file-read* ${sub(secret)})`,
  ].join('\n');
}
