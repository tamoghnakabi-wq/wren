import type { Autonomy, Risk, Runtime } from './types';

// Risk policy shared by cloud and desktop runners.
//
// Each tool call gets a risk level. The agent's autonomy setting decides which
// levels need a human approval:
//   careful    -> medium and above
//   balanced   -> high and above
//   autonomous -> critical only
// "Blocked" calls are never executed, whatever the autonomy.

const ORDER: Risk[] = ['low', 'medium', 'high', 'critical'];
export const riskRank = (r: Risk) => ORDER.indexOf(r);
export const maxRisk = (...rs: Risk[]): Risk => rs.reduce((a, b) => (riskRank(b) > riskRank(a) ? b : a), 'low');
const bump = (r: Risk): Risk => ORDER[Math.min(ORDER.length - 1, riskRank(r) + 1)];

export function needsApproval(risk: Risk, autonomy: Autonomy): boolean {
  const threshold: Risk = autonomy === 'careful' ? 'medium' : autonomy === 'balanced' ? 'high' : 'critical';
  return riskRank(risk) >= riskRank(threshold);
}

export interface Assessment {
  risk: Risk;
  reason?: string;
  blocked?: string; // never allowed
}

// ------------------------------------------------------------------ shell

const READ_ONLY = new Set([
  'ls', 'll', 'dir', 'pwd', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'rg', 'ag', 'find', 'fd',
  'tree', 'du', 'df', 'echo', 'printf', 'which', 'where', 'whoami', 'date', 'uname', 'file', 'stat', 'sort', 'uniq',
  'cut', 'tr', 'jq', 'yq', 'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'type', 'true', 'false',
  'sleep', 'test', 'ps', 'top', 'uptime', 'hostname', 'id', 'groups', 'nproc', 'free', 'lsb_release', 'sw_vers',
  'get-childitem', 'get-content', 'get-location', 'select-string', 'measure-object', 'get-process', 'get-date',
  'md5sum', 'sha256sum', 'shasum', 'man', 'help', 'column', 'nl', 'tac', 'rev', 'seq', 'xxd', 'od', 'strings',
]);

// Only programs that don't pick their binary from files in the project. Toolchains are often run
// through version managers that do (rust-toolchain.toml `path`, .tool-versions `path:`, .yarnrc.yml
// `yarnPath`), so even `cargo --version` can run a program an agent wrote (verified with rustup).
const VERSION_ONLY = /^(git|gh|docker)\s+(-v|--version|version)\s*$/i;

/**
 * Git subcommands that only read refs and config. Everything that reads the index (status, diff,
 * ls-files: fsmonitor hooks, clean filters, post-index-change hooks), shows diffs (external diff,
 * textconv) or shows commits (log, show, blame, reflog: signature checks run gpg.program) can run a
 * program the repository's own config names, and that config is in a folder agents can write (W-88).
 * Built-in names can't be aliased; anything else (an alias) isn't listed here.
 */
function gitReadOnly(args: string[]): boolean {
  const [sub, ...rest] = args;
  const plain = (a: string) => !a.startsWith('-') && !a.includes(':');
  switch (sub) {
    case 'branch':
      return rest.every((a) => /^(-a|--all|-r|--remotes|--list|-v+|--verbose|--no-color)$/.test(a));
    case 'remote':
      return rest.every((a) => a === '-v' || a === '--verbose');
    case 'tag':
      return rest.length > 0 && /^(-l|--list)$/.test(rest[0]) && rest.slice(1).every((a) => /^-n\d*$/.test(a) || plain(a));
    case 'rev-parse':
      return rest.every((a) => /^(--abbrev-ref|--short(=\d+)?|--show-toplevel|--show-prefix|--show-cdup|--git-dir|--absolute-git-dir|--is-inside-work-tree|--is-bare-repository|--verify|-q|--quiet|--symbolic-full-name)$/.test(a) || plain(a));
    case 'describe':
      return rest.every((a) => /^(--tags|--all|--always|--long|--exact-match|--abbrev=\d+|--first-parent)$/.test(a) || plain(a));
    case 'config':
      return (
        rest.length > 0 &&
        /^(--get|--get-all|--get-regexp|-l|--list|get|list)$/.test(rest[0]) &&
        rest.slice(1).every((a) => /^(--global|--local|--system|--show-origin|--show-scope|--name-only|-z|--null|--all)$/.test(a) || !a.startsWith('-'))
      );
    default:
      return false;
  }
}
/** Looks like a git read (status, log, diff…) even though it isn't counted as one: for the reason shown. */
const GIT_LOOKS_READ = /^git\s+(status|log|diff|show|ls-files|blame|shortlog|reflog|stash\s+list|grep|whatchanged|describe)(\s|$)/i;
/** Read commands whose options can still write files or run programs: an unknown argument value makes them unsafe. */
const OPTION_SENSITIVE = new Set(['sort', 'tree', 'uniq', 'xxd', 'yq', 'rg', 'fd', 'date', 'hostname', 'find', 'git', 'gh', 'man', 'less', 'more', 'file', 'ag', 'printf']);

/** Matches at a command position: start, after a control operator, or after sudo/xargs/env. */
const CMD = String.raw`(?:^|[;&|(\x60]\s*|\$\(\s*|\b(?:sudo|xargs|env|exec|nohup|time)\s+)`;

interface Rule {
  re: RegExp;
  /** A program rule doesn't apply to a line this matches too. */
  unless?: RegExp;
  risk: Risk;
  reason: string;
  block?: boolean;
}

const RULES: Rule[] = [
  // never
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, risk: 'critical', reason: 'fork bomb', block: true },
  { re: /\bmkfs(\.\w+)?\b|\bdd\s+[^|]*of=\/dev\/(sd|disk|nvme|hd)/i, risk: 'critical', reason: 'formats or overwrites a disk', block: true },
  { re: /\bdiskutil\s+(erase|zeroDisk|secureErase|partitionDisk)|\bformat\s+[a-z]:|\bClear-Disk\b/i, risk: 'critical', reason: 'erases a disk', block: true },
  // critical: credentials, privilege, system state
  { re: /(^|[;&|]\s*)sudo\b|\bsu\s+-|\bdoas\b|runas\s/i, risk: 'critical', reason: 'runs with elevated privileges' },
  { re: /\bsecurity\s+(find|dump|export|delete)-|\bkeychain\b|\bcmdkey\b|credential(s)?\.(json|db)|\.ssh\/id_|\.aws\/credentials|\.netrc|wallet\.dat|seed\s*phrase/i, risk: 'critical', reason: 'touches credentials or keychains' },
  { re: /\b(shutdown|reboot|halt|poweroff|launchctl\s+(unload|bootout|remove)|systemctl\s+(stop|disable|mask)|Stop-Computer|Restart-Computer)\b/i, risk: 'critical', reason: 'changes system state' },
  { re: /\b(csrutil|spctl\s+--master-disable|nvram|bcdedit|reg\s+(delete|add)|Set-ExecutionPolicy|defaults\s+write\s+\/Library)\b/i, risk: 'critical', reason: 'changes system security settings' },
  { re: /\bchmod\s+-R\s+[0-7]*7[0-7]*\s+\/(\s|$)|\bchown\s+-R\s+\S+\s+\/(\s|$)/i, risk: 'critical', reason: 'changes permissions on the whole system' },
  // high: destructive or externally visible
  // Not an option of that name (`docker run --rm`, `--del`).
  { re: /(?<![-\w.])rm\s|\brmdir\b|\bunlink\b|Remove-Item|(?<![-\w.])del\s|(?<![-\w.])erase\s|\bshred\b|(?<![-\w.])truncate\s|\bfind\b[^|;&]*\s-delete\b/i, risk: 'high', reason: 'deletes files' },
  { re: /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D|rebase|filter-branch|filter-repo|update-ref\s+-d)/i, risk: 'high', reason: 'rewrites or publishes git history' },
  { re: /\bgh\s+(pr\s+(create|merge|close|comment|review|edit)|issue\s+(create|close|comment|edit|delete)|repo\s+(create|delete|archive|edit|rename)|release\s+(create|delete|upload)|api\s+.*((-X|--method)[\s=]*(POST|PUT|PATCH|DELETE)|\s(-f|-F|--field|--raw-field|--input)(\s|=))|secret|workflow\s+run)/i, risk: 'high', reason: 'changes things on GitHub' },
  { re: /\b(npm|pnpm|yarn)\s+publish|\bcargo\s+publish|\btwine\s+upload|\bgem\s+push|\bvercel\s+(deploy\s+.*--prod|--prod|promote|remove|rm)|\bnetlify\s+deploy\s+--prod|\bfly\s+deploy|\bterraform\s+(apply|destroy)|\bkubectl\s+(apply|delete)|\bheroku\b/i, risk: 'high', reason: 'publishes or deploys' },
  { re: new RegExp(`${CMD}(ssh|scp|rsync|sftp|ftp|telnet|nc|ncat|socat)\\s`), risk: 'high', reason: 'connects to another machine' },
  { re: new RegExp(`${CMD}(kill|killall|pkill|taskkill|Stop-Process)\\b`, 'i'), risk: 'high', reason: 'stops processes' },
  { re: new RegExp(`${CMD}(sendmail|mail|mutt|osascript)\\b`), risk: 'high', reason: 'automates apps or sends mail' },
  { re: /(>|>>)\s*~?\/?(\.\w*rc|\.profile|\.bash_profile|\.zprofile|\.gitconfig|\/etc\/)/i, risk: 'high', reason: 'modifies shell or system configuration' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node)\b|iex\s*\(|Invoke-Expression/i, risk: 'high', reason: 'pipes a downloaded script into a shell' },
  { re: /\b(brew|apt|apt-get|dnf|yum|pacman|choco|winget|scoop|port)\s+(install|remove|uninstall|upgrade|purge)/i, risk: 'medium', reason: 'installs or removes system packages' },
];

/** HTTP clients, as a program line names them (folder and case removed). */
const HTTP_CLIENT = String.raw`^(curl|wget|https?|xh|invoke-webrequest|iwr|invoke-restmethod|irm)\s(.*\s)?`;

/**
 * Rules for a program by its name, tested only on the program lines `programLines` gives (`name args…`, for
 * every program a line runs, however it's spelled or wrapped): never on the raw text, where `open(` in a
 * Python one-liner or `http://` in a git URL would match (0.1.50 review).
 */
const PROGRAM_RULES: Rule[] = [
  // POST bodies, uploads, forms and other methods, however they're spelled (A-P3): curl --json, --request PUT,
  // -sd @file (short options in a cluster), -K (options read from a file); wget --post-file, --method, --body-data.
  { re: new RegExp(`${HTTP_CLIENT}(-X\\s*(POST|PUT|PATCH|DELETE)|--request[\\s=]*(POST|PUT|PATCH|DELETE)|--method[\\s=]*(POST|PUT|PATCH|DELETE)|--data|--json\\b|--form\\b|--upload-file|--config\\b|--post-(data|file)|--body-(data|file)|-Method\\s+(Post|Put|Patch|Delete))`, 'i'), risk: 'high', reason: 'sends data to a server' },
  { re: /^curl\s(.*\s)?-[a-zA-Z]*[dFTK]/, risk: 'high', reason: 'sends data to a server' },
  // Docker (through Wren's broker on macOS): what deletes volumes and stopped containers wholesale.
  { re: /^docker\s(.*\s)?(((system|container|image|volume|network|builder|buildx)\s+prune)|(compose\s(.*\s)?down\s(.*\s)?(-v|--volumes)))(\s|$)/, risk: 'high', reason: 'deletes containers’ data' },
  // Anything but launchctl's read-only subcommands (which rate medium, like other programs) starts, stops or
  // changes background services.
  {
    re: /^launchctl(\s|$)/,
    unless: /^launchctl\s+(list|print|print-cache|print-disabled|blame|version|help|hostinfo|managerpid|manageruid|managername|error)(\s|$)/,
    risk: 'high',
    reason: 'starts apps or background services',
  },
];

/**
 * `open` starts its target through LaunchServices, outside any sandbox. Inside Wren's macOS sandbox it can't
 * work (`(deny lsopen)`, A-D2), so it's refused up front with what to do instead, rather than asking the user
 * to approve a command that would fail; elsewhere it rates high.
 */
const OPEN_PROGRAM = /^open(\s|$)/;
const OPEN_IN_SANDBOX =
  "Blocked: Wren's sandbox doesn't let commands open files, apps or web pages with `open` (they would run outside it). Use Wren's open tool (computer.open, or the wren open tool) to show the user a file or page, or give them the path or link.";

/** One simple command: its real argument vector (quotes removed), as the program receives it. */
interface SimpleCommand {
  words: string[];
  /** Per word: contains a $-expansion or command substitution, so its value is unknown. */
  dynamic: boolean[];
  /**
   * Per word: quoting, an escape or an expansion comes before its first "=", so to the shell it's never an
   * assignment: `"LC_ALL=./x" ls` runs the program `LC_ALL=./x` (A-P5).
   */
  quotedName: boolean[];
  /** Output redirection targets. */
  outputs: { target: string; dynamic: boolean }[];
  /** Input redirection sources (`< file`, and here-strings). */
  inputs: string[];
  /**
   * Has an expansion that evaluates arithmetic or more than a plain $name / ${name}: `${a[i]}`, `${a:i}`,
   * `$((…))`, `$[…]`. Arithmetic reads a variable's value as an expression, and an expression with a
   * subscript can run a command: `TZ='x[$(cmd)]'; echo ${COLUMNS[TZ]}` runs cmd (A-P2).
   */
  evaluates?: boolean;
}

/** After a "$": anything but a plain $name, ${name} or special parameter (see SimpleCommand.evaluates). */
const evaluatingExpansion = (after: string) => /^(\{(?!([A-Za-z_]\w*|\d+|[?#$!@*-])\})|\[|\(\()/.test(after);

/**
 * A small shell lexer: splits on control operators outside quotes, removes quotes and
 * backslash escapes, records redirections, and treats $(...) / backticks as separate
 * commands. `normalized` is the command with quoting removed, for the pattern rules.
 * `unsupported` is set for syntax it doesn't follow: here-documents (their text is data to the
 * shell, so a quote in it isn't one) and comments (a quote after "#" is ignored by bash, but not
 * by a shell without comments, e.g. interactive zsh). Past those, its commands may not be the
 * shell's, so such a line is never counted as read-only (W-166).
 */
export function parseShell(command: string): { commands: SimpleCommand[]; normalized: string; unsupported: boolean } {
  const commands: SimpleCommand[] = [];
  let unsupported = false;
  let cur: SimpleCommand = { words: [], dynamic: [], quotedName: [], outputs: [], inputs: [] };
  let word = '';
  let inWord = false;
  let dyn = false;
  let quotedName = false;
  /** Where quoting, an escape or an expansion starts: before any "=", the word can't be an assignment. */
  const quoting = () => {
    if (!word.includes('=')) quotedName = true;
  };
  let pending: 'out' | 'in' | null = null;
  let norm = '';
  const nested: SimpleCommand[] = [];
  /** The commands in a substitution: checked like any other. */
  const sub = (text: string) => {
    const inner = parseShell(text);
    nested.push(...inner.commands);
    if (inner.unsupported) unsupported = true;
    return inner;
  };
  const endWord = () => {
    if (!inWord) return;
    if (pending === 'out') cur.outputs.push({ target: word, dynamic: dyn });
    else if (pending === 'in') cur.inputs.push(word);
    else {
      cur.words.push(word);
      cur.dynamic.push(dyn);
      cur.quotedName.push(quotedName);
    }
    pending = null;
    word = '';
    inWord = false;
    dyn = false;
    quotedName = false;
  };
  const endCommand = () => {
    endWord();
    pending = null;
    if (cur.words.length || cur.outputs.length || cur.inputs.length) commands.push(cur);
    cur = { words: [], dynamic: [], quotedName: [], outputs: [], inputs: [] };
  };
  const n = command.length;
  for (let i = 0; i < n; i++) {
    const c = command[i];
    if (c === "'") {
      quoting();
      const j = command.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      word += command.slice(i + 1, end);
      norm += command.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      quoting();
      inWord = true;
      let j = i + 1;
      for (; j < n && command[j] !== '"'; j++) {
        if (command[j] === '\\' && j + 1 < n && '"\\$`'.includes(command[j + 1])) {
          j++;
          word += command[j];
          norm += command[j];
          continue;
        }
        // "$(...)" and "`...`" still run commands: check them like any other.
        if (command[j] === '$' && command[j + 1] === '(' && command[j + 2] !== '(') {
          const end = closingParen(command, j + 2);
          const inner = sub(command.slice(j + 2, end));
          word += '$(…)';
          norm += `$(${inner.normalized})`;
          dyn = true;
          j = end;
          continue;
        }
        if (command[j] === '`') {
          let end = j + 1;
          while (end < n && command[end] !== '`') end += command[end] === '\\' ? 2 : 1;
          const inner = sub(unBackquote(command.slice(j + 1, end), true));
          word += '$(…)';
          norm += `\`${inner.normalized}\``;
          dyn = true;
          j = end;
          continue;
        }
        if (command[j] === '$') {
          dyn = true;
          if (evaluatingExpansion(command.slice(j + 1, Math.min(n, j + 64)))) cur.evaluates = true;
        }
        word += command[j];
        norm += command[j];
      }
      i = j;
      continue;
    }
    if (c === '$' && command[i + 1] === "'") {
      // $'...' (ANSI-C quoting): decode it, so escapes can't hide a command name.
      quoting();
      let j = i + 2;
      let raw = '';
      for (; j < n && command[j] !== "'"; j++) {
        if (command[j] === '\\' && j + 1 < n) raw += command[j] + command[++j];
        else raw += command[j];
      }
      const text = decodeAnsiC(raw);
      word += text;
      norm += text;
      inWord = true;
      i = j;
      continue;
    }
    if (c === '\\') {
      quoting();
      if (i + 1 < n && command[i + 1] !== '\n') {
        word += command[i + 1];
        norm += command[i + 1];
        inWord = true;
      }
      i++;
      continue;
    }
    if ((c === '$' || c === '<' || c === '>') && command[i + 1] === '(' && !(c === '$' && command[i + 2] === '(')) {
      // $(...) / <(...) / >(...): the inner commands are checked on their own; this word's value is unknown
      const j = closingParen(command, i + 2);
      const inner = sub(command.slice(i + 2, j));
      if (c !== '$') endWord();
      quoting();
      word += '$(…)';
      dyn = true;
      inWord = true;
      norm += `${c}(${inner.normalized})`;
      i = j;
      continue;
    }
    if (c === '`') {
      quoting();
      let j = i + 1;
      while (j < n && command[j] !== '`') j += command[j] === '\\' ? 2 : 1;
      const inner = sub(unBackquote(command.slice(i + 1, j), false));
      word += '$(…)';
      dyn = true;
      inWord = true;
      norm += `\`${inner.normalized}\``;
      i = j;
      continue;
    }
    if (c === '$') {
      quoting();
      dyn = true;
      if (evaluatingExpansion(command.slice(i + 1, Math.min(n, i + 64)))) cur.evaluates = true;
      inWord = true;
      word += c;
      norm += c;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      norm += ' ';
      continue;
    }
    if (c === '\n') {
      endCommand();
      norm += '\n';
      continue;
    }
    if (c === '>' || (c === '&' && command[i + 1] === '>')) {
      // an fd number right before ">" (2>file) is not an argument
      if (inWord && /^\d+$/.test(word) && !dyn) {
        word = '';
        inWord = false;
      } else endWord();
      let op = c;
      if (c === '&') op += command[++i];
      while (command[i + 1] === '>' || command[i + 1] === '|') op += command[++i];
      norm += op;
      if (command[i + 1] === '&') {
        // >&2, 2>&1, >&-: duplicates a descriptor, no file
        let k = i + 2;
        while (k < n && /[0-9-]/.test(command[k])) k++;
        if (k > i + 2) {
          norm += command.slice(i + 1, k);
          i = k - 1;
          continue;
        }
        // >&word: bash writes stdout and stderr to the file `word` (A-P6)
        norm += command[++i];
      }
      pending = 'out';
      continue;
    }
    if (c === '<') {
      endWord();
      let op = c;
      while (command[i + 1] === '<') op += command[++i];
      norm += op;
      // "<<" / "<<-" start a here-document ("<<<" is a here-string: one word, read like any other)
      if (op === '<<') unsupported = true;
      pending = 'in';
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      endCommand();
      norm += c;
      continue;
    }
    // A word starting with "#" is a comment to bash (to the end of the line), a word to some shells.
    if (c === '#' && !inWord) unsupported = true;
    // Unquoted *, ?, [ and {a,b} expand to names only known when the command runs.
    if (c === '*' || c === '?' || c === '[' || c === '{') dyn = true;
    word += c;
    norm += c;
    inWord = true;
  }
  endCommand();
  return { commands: [...commands, ...nested], normalized: norm, unsupported };
}

/**
 * The command inside `...` as the shell runs it: a backslash before $, ` or \ (and " inside double
 * quotes) is removed first, so \`touch x\` nested inside is a command too, not text (W-174).
 */
function unBackquote(text: string, inDoubleQuotes: boolean): string {
  return text.replace(inDoubleQuotes ? /\\([$`\\"])/g : /\\([$`\\])/g, '$1');
}

/** Decodes the escapes of a $'...' string (\\xHH, \\NNN, \\uHHHH, \\n, ...). */
function decodeAnsiC(raw: string): string {
  const named: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  return raw.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)/g, (_, e: string) => {
    if (e[0] === 'x' || e[0] === 'u' || e[0] === 'U') return String.fromCodePoint(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    if (e[0] === 'c') return String.fromCharCode(e.charCodeAt(1) & 31);
    return named[e] ?? '\\' + e;
  });
}

/** Index of the ")" closing a "(" whose contents start at `from` (quotes respected). */
function closingParen(s: string, from: number): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === "'") i = s.indexOf("'", i + 1) < 0 ? s.length : s.indexOf("'", i + 1);
    else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return s.length;
}

const SAFE_OUTPUTS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

/**
 * Commands on the read-only list that still have writing or executing forms:
 * output files given as options or extra positional arguments, in-place edits,
 * and options that run other programs. `args` are the real (unquoted) arguments.
 */
/**
 * A long option, spelled out or abbreviated: getopt_long-style parsers (sort, date, less, file, ag…)
 * accept any unambiguous prefix (`--co` for --compress-program, `--LOG` for --LOG-FILE). Ambiguous
 * prefixes count too: refusing them is the safe side (W-113).
 */
function longOpt(arg: string, ...names: string[]): boolean {
  const n = arg.split('=')[0];
  return n.length > 2 && n.startsWith('--') && names.some((full) => full.startsWith(n));
}

function readOnlyForm(cmd: string, args: string[]): boolean {
  // Operands: "-" is one (standard input: `uniq - OUT` writes OUT, W-167), and so is everything after "--".
  // An option's value counts as an operand too, which only errs on the safe side.
  const end = args.indexOf('--');
  const positional = args.filter((w, i) => (end >= 0 && i > end) || (i !== end && (w === '-' || !w.startsWith('-'))));
  switch (cmd) {
    case 'sort':
      // --output writes; --compress-program runs a program (`--co=./x` works too).
      return !args.some((w) => /^-[a-zA-Z]*o/.test(w) || longOpt(w, '--output', '--compress-program'));
    case 'tree':
      // -R (with -H) writes an 00Tree.html into every folder it lists.
      return !args.some((w) => /^-[a-zA-Z]*[oR]/.test(w) || longOpt(w, '--output'));
    case 'man':
      // -P names the pager (run even without a terminal), -C a config naming programs, -M/-H others:
      // only section numbers, page names and a few listing flags.
      return args.every((w) => (w.startsWith('-') ? /^-[afkwW]+$/.test(w) : /^[\w.:@+-]+$/.test(w)));
    case 'less':
    case 'more':
      // +cmd runs less commands (including !shell); -o/-O write a log; -k loads key bindings.
      return !args.some((w) => w.startsWith('+') || /^-[a-zA-Z]*[oOk]/.test(w) || longOpt(w, '--log-file', '--LOG-FILE', '--lesskey-file', '--lesskey-src', '--lesskey-content'));
    case 'file':
      // -z/-Z may run decompressors found on PATH; -C (--compile) writes a compiled magic file (W-117).
      return !args.some((w) => /^-[a-zA-Z]*[zZC]/.test(w) || longOpt(w, '--uncompress', '--uncompress-noreport', '--compile'));
    case 'ag':
      return !args.some((w) => longOpt(w, '--pager'));
    case 'uniq':
      return positional.length <= 1; // uniq IN OUT writes OUT
    case 'xxd':
      return !args.some((w) => /^-r|^-revert/.test(w)) && positional.length <= 1;
    case 'yq':
      // -i edits in place; -s (--split-exp) writes each result to a file it names.
      return !args.some((w) => /^-[a-zA-Z]*[is]/.test(w) || longOpt(w, '--inplace', '--split-exp'));
    case 'rg':
      // --pre runs a program; -z runs decompressors found on PATH.
      return !args.some((w) => /^-[a-zA-Z]*z/.test(w) || longOpt(w, '--pre', '--search-zip'));
    case 'fd':
      return !args.some((w) => /^-[a-zA-Z]*[xX]/.test(w) || longOpt(w, '--exec', '--exec-batch'));
    case 'date':
      return positional.every((w) => w.startsWith('+')) && !args.some((w) => /^-[a-zA-Z]*s/.test(w) || longOpt(w, '--set'));
    case 'hostname':
      return positional.length === 0;
    case 'find':
      return !args.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(w));
    case 'printf':
      // -v sets a variable instead: `printf -v PATH %s /repo/bin; ls` runs /repo/bin/ls (A-P5).
      return !/^-[a-zA-Z]*v/.test(args[0] ?? '');
    default:
      return true;
  }
}

/** `gh` subcommands that only read: list/view commands, and `gh api` with GET and no fields. */
function ghReadOnly(args: string[]): boolean {
  const [group, sub] = args;
  if (group === 'auth' && sub === 'status') return true;
  if (['pr', 'issue', 'repo', 'run', 'release', 'workflow'].includes(group) && ['list', 'view', 'status', 'diff', 'checks'].includes(sub)) return true;
  if (group !== 'api') return false;
  let method = 'GET';
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-X' || a === '--method') method = args[++i] ?? '';
    else if (a.startsWith('--method=')) method = a.slice(9);
    else if (a.startsWith('-X')) method = a.slice(2).replace(/^=/, '');
    else if (/^(-f|-F|--field|--raw-field|--input)($|=)/.test(a) || /^-[fF]./.test(a)) return false; // fields imply a write
  }
  return method.toUpperCase() === 'GET';
}

/** Variables that can't change which program runs or what it loads. */
// Not PAGER or GIT_PAGER: they name a program to run (`PAGER=./x man ls` runs ./x, terminal or not).
const SAFE_ASSIGNMENT = /^(LC_[A-Z]+|LANG|LANGUAGE|TZ|NO_COLOR|FORCE_COLOR|COLUMNS|LINES|TERM)=/;
/** Where the real system utilities live: a path anywhere else could be any program. */
const SYSTEM_BIN = /^\/(usr\/)?s?bin\/[^/]+$/;

/**
 * Whether a bare program name (no slash) runs a program agents can't have put there. Only the host
 * knows its PATH and which folders agents may write, so it supplies this; without it (the cloud VM,
 * which the agent owns anyway) names are taken at face value.
 */
export type ProgramTrust = (name: string) => boolean;

/** A leading VAR=value word the shell takes as an assignment (not when quoted before its "="). */
const isAssignment = (c: SimpleCommand, k: number) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(c.words[k]) && !c.quotedName[k];

/** The program a command runs: the first word after leading VAR=value assignments. */
function program(c: SimpleCommand): { words: string[]; dynamic: boolean[]; unsafeEnv: boolean } {
  let k = 0;
  while (k < c.words.length && isAssignment(c, k)) k++;
  const unsafeEnv = c.words.slice(0, k).some((w) => !SAFE_ASSIGNMENT.test(w));
  return { words: c.words.slice(k), dynamic: c.dynamic.slice(k), unsafeEnv };
}

function commandIsReadOnly(c: SimpleCommand, trust?: ProgramTrust): boolean {
  if (c.outputs.some((o) => o.dynamic || !SAFE_OUTPUTS.has(o.target))) return false;
  if (c.evaluates) return false;
  const { words, dynamic, unsafeEnv } = program(c);
  if (!words.length) return !dynamic.some(Boolean) && !unsafeEnv;
  // PATH=…, LD_PRELOAD=… etc. can make "ls" a different program.
  if (unsafeEnv) return false;
  if (dynamic[0]) return false; // the program itself is unknown
  // A path names a specific file: only the system's own utilities count as the known commands.
  if (words[0].includes('/') && !SYSTEM_BIN.test(words[0])) return false;
  // A bare name is whatever PATH finds first, which may be a file an agent wrote ("ls" in a writable folder).
  if (trust && !words[0].includes('/') && !trust(words[0])) return false;
  const cmd = words[0].toLowerCase().replace(/^.*[\\/]/, '');
  const args = words.slice(1);
  const line = [cmd, ...args].join(' ');
  if (VERSION_ONLY.test(line)) return true;
  if (OPTION_SENSITIVE.has(cmd) && dynamic.some(Boolean)) return false;
  if (cmd === 'gh') return ghReadOnly(args);
  if (cmd === 'git') return gitReadOnly(args);
  if (!READ_ONLY.has(cmd)) return false;
  return readOnlyForm(cmd, args);
}

/**
 * A line that sets a shell variable (`X=…` on its own) and expands one: the value may be read as
 * arithmetic somewhere Wren doesn't follow, where a subscript in it runs a command (A-P2).
 */
const assignsAndExpands = (commands: SimpleCommand[]) => commands.some((c) => c.words.length > 0 && program(c).words.length === 0) && commands.some((c) => c.dynamic.some(Boolean));

/** True when every command in the line is a known read-only form with fully known arguments. */
export function isReadOnlyCommand(command: string, trust?: ProgramTrust): boolean {
  const { commands, unsupported } = parseShell(command);
  return !unsupported && commands.length > 0 && commands.every((c) => commandIsReadOnly(c, trust) && !c.dynamic.some(Boolean)) && !credentialFiles(commands);
}

/**
 * Files that hold credentials: SSH and GPG keys, cloud, cluster and registry logins, .env files (not their
 * .example/.sample/.template copies) and keychains. One test for read_file, share_file and the files a
 * shell command names (A-P4).
 */
const credentialFile = (sep: string) =>
  new RegExp(
    String.raw`(^|[SEP=])(\.(ssh|aws|gnupg|kube|docker|azure|vercel|codex|grok)([SEP]|$)|\.env(?![^SEP]*\.(example|sample|template|dist)$)(\.[^SEP]*)?$|\.envrc$|\.(netrc|npmrc|pypirc|git-credentials)$|\.config[SEP](gh|gcloud|op|hub)([SEP]|$)|id_(rsa|dsa|ecdsa|ed25519)$|credentials$|[^SEP]*credentials[^SEP]*\.(json|ya?ml|toml|ini|xml|db)$|[^SEP]*\.keychain(-db)?$)`.replaceAll('SEP', sep),
    'i',
  );
/** A file path, where `\` separates folders too (Windows paths, from any host). */
const CREDENTIAL_FILE = credentialFile(String.raw`\\/`);
/** A word on a POSIX command line, where `\` escapes (`rg 'process\.env'` names no .env file). */
const CREDENTIAL_WORD = credentialFile('/');
/** Names a wildcard may stand for in a credentials path (`cat .e*`, `cat ~/.s?h/id_*`). */
const CREDENTIAL_NAMES = ['.env', '.env.local', '.envrc', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.vercel', '.codex', '.grok', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials.json'];
/**
 * Folders that hold a login only in the home folder: in a project, `.vercel/`, `.docker/`, `.codex/` and `.grok/`
 * are its settings. Inside Wren's macOS sandbox the home folder's copies are unreadable wherever a command
 * stands, so a relative path names the project's; elsewhere it may be the home folder's (0.1.50 review).
 */
const HOME_ONLY_LOGINS = /(^|[\\/=])\.(docker|vercel|codex|grok)([\\/]|$)/i;
const HOME_ANCHORED = /^(~[\\/]|\$HOME[\\/]|\$\{HOME\}[\\/]|\/Users\/[^/]+\/|\/home\/[^/]+\/|\/root\/|[a-z]:[\\/]users[\\/][^\\/]+[\\/]|%userprofile%|\$env:userprofile)/i;
/** Programs that only show a name or a file's metadata, never its contents. */
const NAME_ONLY = new Set(['ls', 'test', '[', '[[', 'stat', 'echo', 'printf']);
/** Programs through which a name on the line could reach another program that reads the file. */
const PASSES_ON = new Set(['xargs', 'parallel', 'read', 'eval', 'source', '.', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'deno', 'bun', 'osascript', 'pwsh', 'powershell']);

/**
 * A path to a credentials file, for Wren's own file tools (read, share, write): the same test as a shell
 * command's words (A-P4), Windows separators included.
 */
export const credentialPath = (path: string) => CREDENTIAL_FILE.test(path);

/** One wildcard path segment as a regular expression: * ? [..] and {a,b} as the shell reads them. */
function globSegment(seg: string): RegExp | null {
  if (!/[*?[{]/.test(seg)) return null;
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const j = seg.indexOf(']', i + 2);
      if (j < 0) re += '\\[';
      else {
        re += `[${seg.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = j;
      }
    } else if (c === '{') {
      const j = seg.indexOf('}', i);
      if (j < 0) re += '\\{';
      else {
        re += `(${seg.slice(i + 1, j).split(',').map((a) => a.replace(/[.*+?^$()|[\]\\]/g, '\\$&')).join('|')})`;
        i = j;
      }
    } else re += c.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${re}$`, 'i');
  } catch {
    return /^/; // can't tell what it matches: assume anything
  }
}

/** Where a command line is rated, for reading the names it gives. */
export interface ShellPlace {
  /** Inside Wren's macOS sandbox, which keeps the home folder's credential stores unreadable. */
  sandboxed?: boolean;
  /** `\` separates folders (Windows), rather than escaping the next character. */
  backslashPaths?: boolean;
}

/**
 * Whether a command line's words, redirections or wildcards name a credentials file in a way that reads,
 * copies or loads it (A-P4). Not counted, unless something on the line could hand the name on to another
 * program (`xargs`, `read`, a shell, an interpreter, a substitution): a name that `ls`, `test`, `stat`, `echo`
 * or `printf` only shows, the place `cp` or `mv` writes to, and a file output goes to (`> .env`), none of
 * which reveal what's in it (0.1.50 review).
 */
function credentialFiles(commands: SimpleCommand[], place: ShellPlace = {}): boolean {
  const names = (w: string) => [w, ...(w.includes('=') ? [w.slice(w.indexOf('=') + 1)] : [])];
  const re = place.backslashPaths ? CREDENTIAL_FILE : CREDENTIAL_WORD;
  const sep = place.backslashPaths ? /[\\/]/ : /\//;
  // An expansion or substitution can carry a name anywhere (a wildcard only expands into this program's arguments).
  const expands = (c: SimpleCommand) => c.dynamic.some((d, k) => d && /[$`]|[<>]\(/.test(c.words[k]));
  const passesOn = commands.some((c) => expands(c) || PASSES_ON.has(program(c).words[0]?.replace(/^.*[\\/]/, '').toLowerCase() ?? ''));
  const credential = (w: string) => {
    if (re.test(w)) {
      // A project's own settings folder, inside the sandbox: not a login (the home folder's is unreadable there).
      if (place.sandboxed && HOME_ONLY_LOGINS.test(w) && !HOME_ANCHORED.test(w)) return re.test(w.replace(HOME_ONLY_LOGINS, '$1'));
      return true;
    }
    // A wildcard only stands for a dot name when it starts with "." itself (bash's `*` skips them), and for
    // another name when it starts like it (`id_*`, not `*.json`); {a,b} spells its names out.
    return w.split(sep).some((seg) => {
      const glob = globSegment(seg);
      const spelled = (n: string) => seg[0] === '{' || (n[0] === '.' ? seg[0] === '.' : seg.slice(0, 2).toLowerCase() === n.slice(0, 2));
      return !!glob && CREDENTIAL_NAMES.some((n) => spelled(n) && glob.test(n) && !(place.sandboxed && !HOME_ANCHORED.test(w) && HOME_ONLY_LOGINS.test(n)));
    });
  };
  return commands.some((c) => {
    const p = program(c);
    const lead = c.words.slice(0, c.words.length - p.words.length); // assignments: X=.env counts
    const name = p.words[0]?.replace(/^.*[\\/]/, '').toLowerCase() ?? '';
    let args = p.words.slice(1);
    if (!passesOn && NAME_ONLY.has(name)) args = [];
    // The last operand is where cp/mv write, except with -t/--target-directory, where it's a source.
    else if (!passesOn && (name === 'cp' || name === 'mv') && !args.some((a) => /^-[a-zA-Z]*t|^--target/.test(a))) args = args.slice(0, -1);
    const outputs = passesOn ? c.outputs.map((o) => o.target) : [];
    return [...lead, ...p.words.slice(0, 1), ...args, ...outputs, ...c.inputs].flatMap(names).some(credential);
  });
}

/**
 * Command-line words, split at blanks and operators whatever the quoting; null marks an operator. Read
 * the way a POSIX shell would (quotes, \ and $'...' removed: "r"m, \rm and $'\x72m' are all rm) or the
 * way PowerShell would, where \ separates folders, ` is the escape and { } enclose script blocks.
 */
function roughWords(text: string, shell: 'posix' | 'powershell'): (string | null)[] {
  // PowerShell's "," makes a list of arguments ('C:\Users\me','C:\Temp' is two paths, W-180), and
  // ( ) group them (@('a','b')): neither ends a command there.
  const operator = shell === 'posix' ? /[ \t\n;&|()<>`]/ : /[ \t\n;&|()<>{},]/;
  const separator = shell === 'posix' ? /[ \t]/ : /[ \t,()]/;
  const out: (string | null)[] = [];
  let w = '';
  // PowerShell's ${env:USERPROFILE} is a variable, not a script block.
  for (const c of shell === 'posix' ? text : text.replace(/\$\{([^}]*)\}/g, '$$$1')) {
    if (operator.test(c)) {
      if (w) out.push(w);
      w = '';
      if (!separator.test(c)) out.push(null);
    } else w += c;
  }
  if (w) out.push(w);
  return out.map((x) =>
    x && (shell === 'posix' ? x.replace(/\$'((?:\\.|[^'])*)'?/g, (_, e: string) => decodeAnsiC(e)).replace(/['"\\]/g, '') : x.replace(/['"`]/g, '').replace(/\\/g, '/')),
  );
}

/**
 * The whole system, a top-level folder or a home folder (or everything in one): "/", "/usr/*", "~",
 * "$HOME/.", "~/a/../..", "/Users/me/", and on Windows "C:\\", "C:\\Users\\me", "$env:USERPROFILE",
 * "%USERPROFILE%", "$env:SystemRoot". Case doesn't matter (Windows ignores it). Relative paths depend on the working folder: no.
 */
function wholeTree(path: string): boolean {
  const segs = path.toLowerCase().replace(/\\/g, '/').split('/');
  if (!path) return false;
  const home = /^(~[^/]*|\$home|\$\{home\}|\$env:userprofile|\$\{env:userprofile\}|%userprofile%)$/.test(segs[0]);
  // Some other folder an environment variable names (the Windows folder, Program Files…, in PowerShell's
  // or cmd's spelling): treated as a top-level one.
  const named = !home && /^(\$\{?env:|%[a-z_()]+%)/.test(segs[0]);
  if (!home && !named && segs[0] !== '' && !/^[a-z]:$/.test(segs[0])) return false;
  const parts: string[] = [];
  for (const seg of segs.slice(1)) {
    if (seg === '' || seg === '.') continue;
    if (seg !== '..') parts.push(seg);
    else if (!parts.length) return true; // above the home folder, or the root itself
    else parts.pop();
  }
  while (parts.length && /^\.?\*$/.test(parts[parts.length - 1])) parts.pop();
  if (home || named) return parts.length === 0;
  return parts.length <= 1 || (parts.length === 2 && (parts[0] === 'users' || parts[0] === 'home' || parts.join('/') === 'var/root'));
}

/**
 * rm, and PowerShell's Remove-Item under its names (PowerShell ignores case, so RM is rm too), cmd's rd
 * and .NET's Directory.Delete (recursive with $true).
 */
const REMOVERS = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir', '[system.io.directory]::delete', '[io.directory]::delete']);

/**
 * A recursive delete of the whole system, a top-level folder or a home folder, however its options are
 * spelled: `rm -r -f ~`, `rm ~ -rf` (GNU reads options anywhere), `rm --recursive -- /` (W-168),
 * `RM -r ~ -Force` and `Remove-Item -Recurse -Path:C:\\` in PowerShell (W-175). Read from the words of the
 * text, not the parse, so it holds wherever the lexer and the shell disagree.
 */
function wipesEverything(text: string): boolean {
  for (const shell of ['posix', 'powershell'] as const) {
    const words = roughWords(text, shell);
    for (let i = 0; i < words.length; i++) {
      const name = (words[i] ?? '').toLowerCase();
      const base = name.startsWith('[') ? name : name.replace(/^.*\//, '').replace(/\.exe$/, '');
      // Each shell by its own rules: POSIX has rm; PowerShell has rm and Remove-Item's other names.
      if (shell === 'posix' ? base !== 'rm' : !REMOVERS.has(base)) continue;
      let recursive = false;
      let operands = false;
      const targets: string[] = [];
      const cmd = base === 'rd' || base === 'rmdir';
      // Directory.Delete's arguments follow its "(".
      for (let k = name.startsWith('[') && words[i + 1] === null ? i + 2 : i + 1; k < words.length && words[k] !== null; k++) {
        // PowerShell takes en and em dashes for "-" too.
        const w = words[k]!.replace(/^[\u2013\u2014\u2015]/, '-');
        // cmd's rd /s (its /q is just quiet), and Directory.Delete(path, $true), are recursive too.
        if (shell === 'powershell' && cmd && /^\/[sq]$/i.test(w)) {
          recursive ||= /s/i.test(w);
          continue;
        }
        if (name.startsWith('[') && w.toLowerCase() === '$true') recursive = true;
        if (operands || w === '-' || !w.startsWith('-')) targets.push(w);
        else if (w === '--') operands = true;
        else if (shell === 'posix') {
          // -r, -R, -rf, --rec… (GNU long options in any abbreviation)
          recursive ||= w.startsWith('--') ? longOpt(w, '--recursive') : /[rR]/.test(w);
        } else {
          // PowerShell's -Recurse, in any abbreviation and case (not -Confirm or -ErrorAction); -Path:C:\ names a target too.
          const param = w.split(':')[0].slice(1).toLowerCase();
          recursive ||= param.length > 0 && 'recurse'.startsWith(param);
          if (w.includes(':')) targets.push(w.slice(w.indexOf(':') + 1));
        }
      }
      if (recursive && targets.some(wholeTree)) return true;
    }
  }
  return false;
}

/** Keywords that come before a command without being its program. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time']);
/**
 * Programs that run the command after their options, each with the short options that take a value
 * (`sudo -u root ssh …`: root is the value, ssh the program). Long options are skipped whole.
 */
const WRAPPERS: Record<string, string> = {
  sudo: 'ughpCDrtTU',
  doas: 'uC',
  env: 'uSPC',
  xargs: 'IJLnPsEdaRS',
  nice: 'n',
  exec: 'a',
  nohup: '',
  builtin: '',
  command: '',
  timeout: 'sk',
  caffeinate: 'tw',
  stdbuf: 'ioe',
  time: 'fo',
  setsid: '',
  arch: 'ed', // and -arch NAME, below
  flock: 'wEc', // its lock file comes first, below; -c runs a script
  watch: 'nq', // its command words are joined and run by sh, below
};
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

/**
 * Every program a simple command runs, as `name args…` with its folder, case, leading assignments,
 * keywords and wrappers removed (`/usr/bin/osascript`, `then scp`, `command nc`, `sudo -u x kill`),
 * so the program rules see each one at a command position however it was spelled (A-P3). A wrapper
 * gives a line of its own too, for its own rule (sudo). The command strings of `sh -c`, `eval` and
 * `env -S` go to `scripts`, and `find -exec`'s command is followed into; `unknown` is set when a
 * program's name is only known when the command runs.
 */
function programLines(c: SimpleCommand, out: { lines: string[]; scripts: string[]; unknown: boolean }, depth = 0): void {
  const { words, dynamic } = c;
  let i = 0;
  let wrapped = false; // after env or sudo, which read NAME=value words themselves, quoted or not
  while (i < words.length) {
    if (isAssignment(c, i) || (wrapped && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) {
      i++;
      continue;
    }
    if (dynamic[i]) {
      out.unknown = true;
      return;
    }
    const name = words[i].replace(/^.*[\\/]/, '').toLowerCase();
    const args = words.slice(i + 1);
    out.lines.push([name, ...args].join(' '));
    if (KEYWORDS.has(name)) {
      i++;
      continue;
    }
    if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(args[0] ?? '')) return; // command -v only looks the name up
    // Own properties only: `constructor` or `__proto__` as a program isn't a wrapper (0.1.50 review).
    if (Object.hasOwn(WRAPPERS, name)) {
      const takes = WRAPPERS[name];
      let script: string | undefined;
      const toScript = (w: string, k: number) => {
        if (dynamic[k]) out.unknown = true;
        else script = w;
      };
      for (i++; i < words.length && words[i].startsWith('-') && words[i] !== '-'; ) {
        const o = words[i++];
        if (o === '--') break;
        if (dynamic[i - 1]) {
          out.unknown = true; // an option only known when it runs can be anything (env -S "$X")
          return;
        }
        if (name === 'arch' && o === '-arch') {
          i++; // arch -arch arm64 prog
          continue;
        }
        if (o.startsWith('--')) {
          if (name === 'env' && o.startsWith('--split-string=')) out.scripts.push(o.slice(15));
          if (name === 'flock' && o.startsWith('--command=')) script = o.slice(10);
          continue;
        }
        const at = [...o.slice(1)].findIndex((ch) => takes.includes(ch));
        if (at < 0) continue;
        const k = at === o.length - 2 ? i++ : i - 1;
        const value = at === o.length - 2 ? words[k] ?? '' : o.slice(at + 2); // -u root, or -uroot
        if (name === 'env' && o[at + 1] === 'S') out.scripts.push(value); // env -S 'prog args' splits it into words
        if (name === 'flock' && o[at + 1] === 'c') toScript(value, k);
      }
      if (name === 'timeout') i++; // its first operand is the time limit
      if (name === 'flock') {
        i++; // the lock file; then a program, or -c 'script'
        if (/^(-c|--command)$/.test(words[i] ?? '')) toScript(words[i + 1] ?? '', i + 1);
      }
      if (name === 'watch') {
        if (dynamic.slice(i).some(Boolean)) out.unknown = true;
        else script = words.slice(i).join(' '); // sh -c "<the words>"
      }
      if (out.unknown) return;
      if (script !== undefined) {
        out.scripts.push(script);
        return;
      }
      wrapped = name === 'env' || name === 'sudo' || name === 'doas';
      continue;
    }
    if (SHELLS.has(name)) {
      // sh -c 'script' (also -lc, -ec …): the script's own commands are rated like any others
      let k = i + 1;
      let script = false;
      for (; k < words.length && /^[-+]./.test(words[k]) && words[k] !== '--'; k++) {
        if (/^-[a-zA-Z]*c/.test(words[k])) script = true;
        else if (/^[-+][oO]$/.test(words[k])) k++; // -o pipefail
      }
      if (words[k] === '--') k++;
      if (script && k < words.length) {
        if (dynamic[k]) out.unknown = true;
        else out.scripts.push(words[k]);
      }
      return;
    }
    if (name === 'eval') {
      if (dynamic.slice(i + 1).some(Boolean)) out.unknown = true;
      else out.scripts.push(args.join(' '));
      return;
    }
    if (name === 'find' && depth < 8) {
      for (let k = i + 1; k < words.length; k++) {
        if (!/^-(exec|execdir|ok|okdir)$/.test(words[k])) continue;
        let e = k + 1;
        while (e < words.length && words[e] !== ';' && words[e] !== '+') e++;
        const span = (a: boolean[]) => a.slice(k + 1, e);
        // find runs the program itself: no word there is an assignment
        programLines({ words: words.slice(k + 1, e), dynamic: span(dynamic), quotedName: span(dynamic).map(() => true), outputs: [], inputs: [] }, out, depth + 1);
        k = e;
      }
    }
    return;
  }
}

export function assessShell(command: string, runtime: Runtime, trust?: ProgramTrust, place: ShellPlace = {}): Assessment {
  // Nothing to run: not something Wren can call routine (a tool that sent no command, A-D3).
  if (!command.trim()) return { risk: 'medium', reason: 'has no command to check' };
  let risk: Risk = 'low';
  let reason: string | undefined;
  // Rules see both the text as written and with quoting removed ("rm" -rf ~ is rm -rf ~).
  const { commands, normalized, unsupported } = parseShell(command);
  if (wipesEverything(command) || wipesEverything(normalized)) {
    const reason = 'deletes the whole filesystem, a top-level folder or a home folder';
    return { risk: 'critical', reason, blocked: `Blocked: this command ${reason}.` };
  }
  for (const rule of RULES) {
    if (rule.re.test(command) || rule.re.test(normalized)) {
      if (rule.block) return { risk: 'critical', reason: rule.reason, blocked: `Blocked: this command ${rule.reason}.` };
      if (riskRank(rule.risk) > riskRank(risk)) {
        risk = rule.risk;
        reason = rule.reason;
      }
    }
  }
  // The same rules for every program the line runs, by name and wherever it stands (A-P3), including the
  // commands of `sh -c '…'` and `eval` (whose own text is checked for wiping everything too).
  const all = [...commands];
  const found = { lines: [] as string[], scripts: [] as string[], unknown: false };
  for (let k = 0; k < all.length && k < 400; k++) {
    programLines(all[k], found);
    for (const script of found.scripts.splice(0)) {
      if (wipesEverything(script)) {
        const reason = 'deletes the whole filesystem, a top-level folder or a home folder';
        return { risk: 'critical', reason, blocked: `Blocked: this command ${reason}.` };
      }
      all.push(...parseShell(script).commands);
    }
  }
  for (const line of found.lines) {
    if (runtime === 'desktop' && OPEN_PROGRAM.test(line)) {
      if (place.sandboxed) return { risk: 'high', reason: 'opens files, apps or pages outside the sandbox', blocked: OPEN_IN_SANDBOX };
      if (riskRank('high') > riskRank(risk)) {
        risk = 'high';
        reason = 'starts apps outside the sandbox';
      }
    }
    for (const rule of [...RULES, ...PROGRAM_RULES]) {
      if (!rule.re.test(line) || rule.unless?.test(line)) continue;
      if (rule.block) return { risk: 'critical', reason: rule.reason, blocked: `Blocked: this command ${rule.reason}.` };
      if (riskRank(rule.risk) > riskRank(risk)) {
        risk = rule.risk;
        reason = rule.reason;
      }
    }
  }
  // A program whose name is only known when the command runs (from $VAR, $(...), a wildcard)
  // can't be judged: ask, like for anything else that could do real damage.
  if (riskRank(risk) < riskRank('high') && (found.unknown || commands.some((c) => program(c).dynamic[0]))) {
    risk = 'high';
    reason = 'runs a program whose name is only known when it runs';
  }
  // Credentials: as for read_file, whichever command reads, copies or changes them (A-P4).
  // On Windows the line is PowerShell, where `\` separates folders: read its words that way too (cat src\.env).
  const powershellNames = () => !!place.backslashPaths && roughWords(command, 'powershell').some((w) => !!w && CREDENTIAL_FILE.test(w));
  if (riskRank(risk) < riskRank('critical') && (credentialFiles(all, place) || powershellNames())) {
    risk = 'critical';
    reason = 'reads or changes a credentials file';
  }
  if (risk === 'low') {
    const ro = !unsupported && commands.every((c) => commandIsReadOnly(c, trust)) && !assignsAndExpands(commands);
    if (!ro) {
      risk = 'medium';
      reason = unsupported
        ? 'has a here-document or a comment, so Wren can’t be sure which parts are commands'
        : commands.every((c) => commandIsReadOnly(c))
        ? 'runs a program found in a folder agents can write to, so it may not be the usual one'
        : GIT_LOOKS_READ.test(normalized.trim())
          ? 'git can run programs named in the repository’s own settings (hooks, filters, diff tools)'
          : 'runs a program that can change files';
    }
  }
  // The cloud computer is an isolated VM owned by the agent: one level less
  // cautious for local file changes, but anything externally visible stays.
  if (runtime === 'cloud' && risk === 'medium') risk = 'low';
  if (runtime === 'cloud' && risk === 'high' && reason === 'deletes files') risk = 'medium';
  return { risk, reason };
}

// ------------------------------------------------------------------ other tools

const PURCHASE = /\b(buy|purchase|checkout|check out|place (your )?order|pay( now)?|payment|subscribe|donate|transfer|send money|confirm order|complete order|book now)\b/i;
const DESTRUCTIVE_UI = /\b(delete|remove|cancel (my )?(subscription|account)|close account|unsubscribe|deactivate|revoke|reset)\b/i;
const SENDING_UI = /\b(send|post|publish|tweet|reply|submit|share|invite|merge|deploy)\b/i;

export interface BrowserTarget {
  label?: string; // accessible name / text of the element
  role?: string;
  inputType?: string; // password, email, ...
  autocomplete?: string;
  url?: string;
  href?: string;
  /** Where a form the element belongs to submits ("POST https://..."). */
  form?: string;
  /** Identity of the exact element (stable for the life of the page, unlike e12 refs). */
  elementId?: string;
}

/** A password, card, one-time code or similar field: agents never put text into one. */
const secretField = (target: BrowserTarget | undefined) =>
  /password|cc-|card|cvc|cvv|security code|one-time|otp|2fa|passcode|ssn|social security|iban|routing/.test(`${target?.inputType ?? ''} ${target?.autocomplete ?? ''} ${target?.label ?? ''}`.toLowerCase());
const CREDENTIALS: Assessment = { risk: 'critical', reason: 'enters credentials or payment details', blocked: 'Blocked: agents never type passwords, card numbers or other credentials. Ask the user to do this step.' };

export function assessBrowser(action: string, target: BrowserTarget | undefined, runtime: Runtime): Assessment {
  const text = `${target?.label ?? ''}`;
  if (action === 'type') {
    if (secretField(target)) return CREDENTIALS;
    return { risk: runtime === 'desktop' ? 'medium' : 'low', reason: 'fills in a form field' };
  }
  if (action === 'click' || action === 'press') {
    if (PURCHASE.test(text)) return { risk: 'critical', reason: `may spend money ("${text.slice(0, 60)}")` };
    if (DESTRUCTIVE_UI.test(text)) return { risk: 'high', reason: `may delete or cancel something ("${text.slice(0, 60)}")` };
    if (SENDING_UI.test(text)) return { risk: 'high', reason: `may send or publish something ("${text.slice(0, 60)}")` };
    return { risk: runtime === 'desktop' ? 'medium' : 'low', reason: 'interacts with the page' };
  }
  return { risk: 'low' };
}

export function assessFileWrite(path: string, runtime: Runtime, existing: boolean): Assessment {
  // The same files as reading them (A-P4): changing one that exists can replace a login; a new one reveals nothing.
  if (credentialPath(path) && existing) return { risk: 'critical', reason: 'changes a credentials file' };
  if (runtime === 'cloud') return { risk: 'low' };
  return { risk: existing ? 'medium' : 'medium', reason: existing ? 'overwrites a file on your computer' : 'creates a file on your computer' };
}

/**
 * The ordinary things an agent writes in a repository, each by its method and whole endpoint (round 29): issues,
 * pull requests and reviews, comments, files, git data, labels, milestones, releases, statuses and checks, merges,
 * dispatches, and running, re-running or cancelling existing workflows. Anything else, even below one of these
 * (`check-suites/preferences`, a review's dismissal), is administration and rates critical, including endpoints
 * GitHub adds later (W-188).
 */
const GITHUB_REPO_WRITES: [string, RegExp][] = (
  [
    ['POST', 'issues'],
    ['PATCH', 'issues/\\d+'],
    ['PUT', 'issues/\\d+/lock'],
    ['POST', 'issues/\\d+/(comments|labels|assignees|reactions)'],
    ['PUT', 'issues/\\d+/labels'],
    ['PATCH', 'issues/comments/\\d+'],
    ['POST', 'issues/comments/\\d+/reactions'],
    ['POST', 'pulls'],
    ['PATCH', 'pulls/\\d+'],
    ['PUT', 'pulls/\\d+/(merge|update-branch)'],
    ['POST', 'pulls/\\d+/(reviews|comments|requested_reviewers)'],
    ['PUT', 'pulls/\\d+/reviews/\\d+'],
    ['POST', 'pulls/\\d+/reviews/\\d+/events'],
    ['POST', 'pulls/\\d+/comments/\\d+/replies'],
    ['PATCH', 'pulls/comments/\\d+'],
    ['POST', 'pulls/comments/\\d+/reactions'],
    ['PATCH', 'comments/\\d+'],
    ['POST', 'comments/\\d+/reactions'],
    ['POST', 'commits/[^/]+/comments'],
    ['PUT', 'contents/.+'],
    ['POST', 'git/(blobs|trees|commits|refs|tags)'],
    ['PATCH', 'git/refs/.+'],
    ['POST', '(labels|milestones|releases)'],
    ['PATCH', '(labels/[^/]+|milestones/\\d+|releases/\\d+|releases/assets/\\d+)'],
    ['POST', 'releases/generate-notes'],
    ['POST', 'statuses/[^/]+'],
    ['POST', '(check-runs|check-suites)'],
    ['PATCH', 'check-runs/\\d+'],
    ['POST', '(check-runs|check-suites)/\\d+/rerequest'],
    ['POST', '(merges|merge-upstream|dispatches)'],
    ['PUT', '(notifications|subscription)'],
    ['POST', 'actions/workflows/[^/]+/dispatches'],
    ['POST', 'actions/runs/\\d+/(rerun|rerun-failed-jobs|cancel|force-cancel)'],
    ['POST', 'actions/jobs/\\d+/rerun'],
  ] as const
).map(([m, p]) => [m, new RegExp(`^/repos/[^/]+/[^/]+/${p}$`)]);
const ordinaryRepoWrite = (method: string, path: string) => GITHUB_REPO_WRITES.some(([m, re]) => m === method && re.test(path));
/** Account-wide settings: organisations, teams, the user's own keys and emails, apps and enterprises. */
const GITHUB_ACCOUNT_GUARDED = /^\/(orgs|organizations|scim|teams|enterprises|admin|authorizations|applications|app|installation|repositories)(\/|$)|^\/user(\/(emails|keys|gpg_keys|ssh_signing_keys|memberships|repository_invitations|installations|blocks|interaction-limits|social_accounts|codespaces\/secrets)(\/|$)|$)/;
/** Workflow files run with the repository's Actions secrets, so writing one is like reading them. */
const GITHUB_WORKFLOWS = /^\/repos\/[^/]+\/[^/]+\/contents\/\.github\/(workflows|actions)(\/|$)/;

/**
 * The path GitHub will act on, as the brokers' `fetch` resolves `https://api.github.com` + path: dot segments
 * resolved (also `%2e`), query and fragment dropped, then percent-escapes decoded, repeated slashes merged, lower
 * case and no trailing slash, so no spelling reads as a different endpoint. Null if it can't be read.
 */
function githubPath(path: string): string | null {
  try {
    const p = decodeURIComponent(new URL(`https://api.github.com${path}`).pathname).toLowerCase().replace(/\/{2,}/g, '/');
    return p.length > 1 ? p.replace(/\/$/, '') : p;
  } catch {
    return null;
  }
}

/**
 * GitHub calls by what they change. Only the method and path are known for most of the API, so whole
 * endpoints are rated by the most they can do: repository settings (`PATCH /repos/o/r`: visibility, security
 * features, archiving), every repository write that isn't an ordinary one by method and endpoint (`GITHUB_REPO_WRITES`) and
 * account-wide settings are critical, so even an autonomous agent asks (W-188). GraphQL is read-only only when
 * the document has no mutation in it.
 */
export function assessGithub(method: string, path: string, body?: unknown): Assessment {
  const m = method.toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(m)) return { risk: 'critical', reason: 'uses an HTTP method Wren doesn’t know', blocked: 'Blocked: GitHub requests use GET, POST, PATCH, PUT or DELETE.' };
  const p = githubPath(path);
  if (p === null) return { risk: 'critical', reason: 'calls a GitHub address Wren can’t read' };
  if (m === 'GET') return { risk: 'low' };
  if (p === '/graphql') {
    const q = body && typeof body === 'object' ? (body as { query?: unknown }).query : undefined;
    // An operation's type is a bare keyword in the document: without "mutation" it can only read.
    if (m === 'POST' && typeof q === 'string' && !/\bmutation\b/i.test(q)) return { risk: 'low' };
    return { risk: 'critical', reason: 'changes GitHub through GraphQL, which Wren can’t check' };
  }
  if (m === 'DELETE') return { risk: 'critical', reason: 'deletes data on GitHub' };
  if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) return { risk: 'critical', reason: 'changes repository settings (visibility, security or access)' };
  if (GITHUB_WORKFLOWS.test(p)) return { risk: 'critical', reason: 'changes a GitHub Actions workflow, which runs with the repository’s secrets' };
  if (/^\/repos\//.test(p) && !ordinaryRepoWrite(m, p)) return { risk: 'critical', reason: 'changes how the repository is run or protected (access, security, Actions, publishing or settings)' };
  if (GITHUB_ACCOUNT_GUARDED.test(p)) return { risk: 'critical', reason: 'changes account or organisation security, access or settings' };
  if (/\/pulls\/\d+\/merge$|\/merges?$/.test(p)) return { risk: 'high', reason: 'merges a pull request' };
  return { risk: 'high', reason: 'writes to GitHub' };
}

/** Lookups the host can provide for assessing a call. */
export interface RiskContext {
  browserTarget?: BrowserTarget;
  fileExists?: boolean;
  mcpReadOnly?: boolean;
  unsandboxed?: boolean;
  /** Shell: which bare program names resolve to programs agents can't have written. */
  trustedProgram?: ProgramTrust;
}

/**
 * Assess a tool call. `context` carries lookups the host can provide (e.g. the
 * browser element behind a ref, whether a file exists).
 */
export function assessCall(
  name: string,
  args: Record<string, unknown>,
  runtime: Runtime,
  context: RiskContext = {},
): Assessment {
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
  switch (name) {
    case 'computer.shell': {
      // The desktop says whether its sandbox is on (macOS) or not (Windows); the cloud says neither.
      const place = runtime === 'desktop' ? { sandboxed: context.unsandboxed === false, backslashPaths: context.unsandboxed === true } : {};
      const a = assessShell(s('command'), runtime, context.trustedProgram, place);
      // Without an OS sandbox (Windows) even a "read-only" command could read any of the user's
      // files, not just the allowed folders, so every command asks unless the agent is autonomous.
      if (context.unsandboxed && !a.blocked && riskRank(a.risk) < riskRank('high')) {
        return { risk: 'high', reason: 'runs a command without a sandbox (Windows), so it could read or change any of your files' };
      }
      return a;
    }
    case 'computer.write_file':
    case 'computer.edit_file':
      return assessFileWrite(s('path'), runtime, context.fileExists ?? name === 'computer.edit_file');
    case 'computer.read_file':
      if (credentialPath(s('path'))) return { risk: 'critical', reason: 'reads a credentials file' };
      return { risk: 'low' };
    case 'computer.open': {
      // Showing something on the user's screen (desktop). A link opens in their own browser, signed in to their
      // accounts, so any link asks in balanced mode: a local one too, since the agent decides what a local page
      // serves and it can send the browser on anywhere at once. Only http(s) is opened (the host checks again).
      const target = s('target').trim();
      if (/^[a-z][a-z0-9+.-]+:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) {
        if (!/^https?:\/\//i.test(target)) return { risk: 'high', reason: 'opens a link that isn’t a web page', blocked: 'Blocked: only http(s) links can be opened.' };
        return { risk: 'high', reason: 'opens a web page in your browser, where you’re signed in' };
      }
      return { risk: 'medium', reason: args.reveal === true ? 'shows a file in Finder' : 'opens a file on your screen' };
    }
    case 'computer.share_file':
      // Sharing copies the file into Wren's file store: like reading it, and then keeping it (A-P4).
      if (credentialPath(s('path'))) return { risk: 'critical', reason: 'shares a credentials file' };
      return { risk: 'low' };
    case 'computer.list_files':
    case 'computer.shell_status':
    // Only this task's own jobs, which end with it anyway (W-186); stopping any other process stays `kill`, high.
    case 'computer.shell_stop':
      return { risk: 'low' };
    case 'browser.click':
    case 'browser.type':
    case 'browser.press': {
      const action = name.split('.')[1];
      const target = context.browserTarget;
      // One key at a time is still typing: not into a password or card field.
      if (action === 'press' && secretField(target) && typesText(s('key'))) return CREDENTIALS;
      // press acts on the focused element; only keys that can activate or submit it matter.
      if (action === 'press' && !isActivatingKey(s('key'))) return { risk: 'low' };
      const a = assessBrowser(action, target, runtime);
      if (a.blocked) return a;
      // Without knowing what the element is, never treat the action as routine.
      if (!target) return { risk: maxRisk(a.risk, 'high'), reason: 'acts on a page element Wren could not inspect' };
      if (action === 'type' && args.submit === true) return { risk: maxRisk(a.risk, runtime === 'desktop' ? 'high' : 'medium'), reason: 'types and submits a form' };
      return a;
    }
    case 'browser.navigate': {
      const url = s('url');
      if (!/^https?:\/\//i.test(url)) return { risk: 'high', reason: 'opens a non-web URL', blocked: 'Blocked: only http(s) URLs can be opened.' };
      if (runtime === 'desktop' && /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url)) {
        return { risk: 'medium', reason: 'opens a page on your local network' };
      }
      return { risk: 'low' };
    }
    case 'web.fetch':
      return { risk: 'low' };
    case 'github.request':
      return assessGithub(s('method') || 'GET', s('path'), args.body);
    case 'screen.capture':
      return { risk: 'high', reason: 'captures your screen' };
    case 'memory.remember':
    case 'memory.forget':
    case 'task.update_plan':
    case 'task.ask_user':
    case 'task.ask_agent':
    case 'task.notify':
    case 'task.show_page':
    case 'browser.snapshot':
    case 'browser.screenshot':
    case 'browser.scroll':
    case 'browser.back':
      return { risk: 'low' };
    default:
      // A server's readOnlyHint is its own claim, so it never lowers the risk.
      if (name.startsWith('mcp_')) return { risk: 'high', reason: context.mcpReadOnly ? 'calls a connected service (the service says this is read-only)' : 'calls a connected service' };
      // A Grok Build tool Wren doesn't know, or one missing what Wren checks (a shell call's command, a file
      // tool's path): it may do anything, so it asks unless the agent is autonomous (A-D3).
      if (name.startsWith('grok.')) return { risk: 'high', reason: 'uses a Grok Build tool Wren can’t check' };
      return { risk: 'medium', reason: 'unrecognised tool' };
  }
}

/** Playwright's key syntax: "Shift+Enter" is Shift, then Enter; "Shift++" ends in "+". Every part is pressed, in order. */
export function keyParts(key: string): string[] {
  const parts: string[] = [];
  let part = '';
  for (const c of key) {
    if (c === '+' && part) {
      parts.push(part);
      part = '';
    } else part += c;
  }
  parts.push(part);
  return parts;
}

/** Keys of Playwright's layout that neither click, submit nor toggle what has focus (Enter, its "\n"/"\r" aliases and Space do). */
const PLAIN_KEY = /^(Escape|F([1-9]|1[0-2])|Backquote|Digit[0-9]|Minus|Equal|Backslash|Backspace|Tab|Key[A-Z]|Bracket(Left|Right)|CapsLock|Semicolon|Quote|Comma|Period|Slash|Shift(Left|Right)?|AltGraph|ContextMenu|PrintScreen|ScrollLock|Pause|PageUp|PageDown|Insert|Delete|Home|End|Arrow(Left|Up|Right|Down)|AudioVolume(Mute|Down|Up)|Media(TrackNext|TrackPrevious|PlayPause)|NumLock|Numpad(Divide|Multiply|Subtract|Add|Decimal|[0-9]))$/;
/** Modifiers that make a chord a shortcut (the page's, or an access key: Alt+Shift+S saves a wiki edit). */
const SHORTCUT_MODIFIER = /^(Control|Alt|Meta)(Left|Right)?$|^ControlOrMeta$/;

/**
 * Keys that can click, submit or toggle the focused element, or trigger a shortcut. Every part of a
 * chord counts (Playwright presses them all: "Enter+a" presses Enter), and anything not known to be
 * plain does too: Enter, "\n", "\r", Space, " ", a key Wren doesn't know (W-165). "" means the
 * controller's default, Enter.
 */
export function isActivatingKey(key: string): boolean {
  if (key === '') return true;
  const parts = keyParts(key);
  if (parts.length > 1 && parts.some((p) => SHORTCUT_MODIFIER.test(p))) return true;
  return parts.some((p) => !SHORTCUT_MODIFIER.test(p) && !PLAIN_KEY.test(p) && !(p.length === 1 && /\S/.test(p)));
}

/** Keys that can't put text into a field: pressing any other into a password field types into it. */
const NO_TEXT_KEY = /^(Enter|NumpadEnter|\n|\r|Tab|Escape|Backspace|Delete|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|(Shift|Control|Alt|Meta)(Left|Right)?|ControlOrMeta|AltGraph|CapsLock|NumLock|ScrollLock|Pause|F([1-9]|1[0-2]))$/;
export const typesText = (key: string) => keyParts(key || 'Enter').some((p) => !NO_TEXT_KEY.test(p));

export { bump as bumpRisk };
