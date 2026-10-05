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

const VERSION_ONLY = /^(node|npm|npx|pnpm|yarn|bun|python3?|pip3?|go|cargo|rustc|java|ruby|git|gh|docker|deno)\s+(-v|--version|version)\s*$/i;

const GIT_READ = /^git\s+(status|log|diff|show|branch(\s+(-a|-r|--list|-v+))?\s*$|remote(\s+-v)?\s*$|rev-parse|ls-files|blame|describe|tag(\s+-l)?\s*$|config\s+--get|shortlog|reflog\s*$|stash\s+list)/i;
/** Read commands whose options can still write files or run programs: an unknown argument value makes them unsafe. */
const OPTION_SENSITIVE = new Set(['sort', 'tree', 'uniq', 'xxd', 'yq', 'rg', 'fd', 'date', 'hostname', 'find', 'git', 'gh']);

/** Matches at a command position: start, after a control operator, or after sudo/xargs/env. */
const CMD = String.raw`(?:^|[;&|(\x60]\s*|\$\(\s*|\b(?:sudo|xargs|env|exec|nohup|time)\s+)`;

interface Rule {
  re: RegExp;
  risk: Risk;
  reason: string;
  block?: boolean;
}

const RULES: Rule[] = [
  // never
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, risk: 'critical', reason: 'fork bomb', block: true },
  { re: /\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)\s+(--no-preserve-root\s+)?(\/|~|\$HOME|\/\*)(\s|$)/i, risk: 'critical', reason: 'deletes the whole filesystem or home folder', block: true },
  { re: /\bmkfs(\.\w+)?\b|\bdd\s+[^|]*of=\/dev\/(sd|disk|nvme|hd)/i, risk: 'critical', reason: 'formats or overwrites a disk', block: true },
  { re: /\bdiskutil\s+(erase|zeroDisk|secureErase|partitionDisk)|\bformat\s+[a-z]:|\bClear-Disk\b/i, risk: 'critical', reason: 'erases a disk', block: true },
  // critical: credentials, privilege, system state
  { re: /(^|[;&|]\s*)sudo\b|\bsu\s+-|\bdoas\b|runas\s/i, risk: 'critical', reason: 'runs with elevated privileges' },
  { re: /\bsecurity\s+(find|dump|export|delete)-|\bkeychain\b|\bcmdkey\b|credential(s)?\.(json|db)|\.ssh\/id_|\.aws\/credentials|\.netrc|wallet\.dat|seed\s*phrase/i, risk: 'critical', reason: 'touches credentials or keychains' },
  { re: /\b(shutdown|reboot|halt|poweroff|launchctl\s+(unload|bootout|remove)|systemctl\s+(stop|disable|mask)|Stop-Computer|Restart-Computer)\b/i, risk: 'critical', reason: 'changes system state' },
  { re: /\b(csrutil|spctl\s+--master-disable|nvram|bcdedit|reg\s+(delete|add)|Set-ExecutionPolicy|defaults\s+write\s+\/Library)\b/i, risk: 'critical', reason: 'changes system security settings' },
  { re: /\bchmod\s+-R\s+[0-7]*7[0-7]*\s+\/(\s|$)|\bchown\s+-R\s+\S+\s+\/(\s|$)/i, risk: 'critical', reason: 'changes permissions on the whole system' },
  // high: destructive or externally visible
  { re: /\brm\s|\brmdir\b|\bunlink\b|Remove-Item|\bdel\s|\berase\s|\bshred\b|\btruncate\s|\bfind\b[^|;&]*\s-delete\b/i, risk: 'high', reason: 'deletes files' },
  { re: /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D|rebase|filter-branch|filter-repo|update-ref\s+-d)/i, risk: 'high', reason: 'rewrites or publishes git history' },
  { re: /\bgh\s+(pr\s+(create|merge|close|comment|review|edit)|issue\s+(create|close|comment|edit|delete)|repo\s+(create|delete|archive|edit|rename)|release\s+(create|delete|upload)|api\s+.*((-X|--method)[\s=]*(POST|PUT|PATCH|DELETE)|\s(-f|-F|--field|--raw-field|--input)(\s|=))|secret|workflow\s+run)/i, risk: 'high', reason: 'changes things on GitHub' },
  { re: /\b(npm|pnpm|yarn)\s+publish|\bcargo\s+publish|\btwine\s+upload|\bgem\s+push|\bvercel\s+(deploy\s+.*--prod|--prod|promote|remove|rm)|\bnetlify\s+deploy\s+--prod|\bfly\s+deploy|\bterraform\s+(apply|destroy)|\bkubectl\s+(apply|delete)|\bheroku\b/i, risk: 'high', reason: 'publishes or deploys' },
  { re: /\b(curl|wget|http|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s|--upload-file|-F\s|-T\s|-Method\s+(Post|Put|Patch|Delete))/i, risk: 'high', reason: 'sends data to a server' },
  { re: new RegExp(`${CMD}(ssh|scp|rsync|sftp|ftp|telnet|nc|ncat|socat)\\s`), risk: 'high', reason: 'connects to another machine' },
  { re: new RegExp(`${CMD}(kill|killall|pkill|taskkill|Stop-Process)\\b`, 'i'), risk: 'high', reason: 'stops processes' },
  { re: new RegExp(`${CMD}(sendmail|mail|mutt|osascript)\\b`), risk: 'high', reason: 'automates apps or sends mail' },
  { re: /(>|>>)\s*~?\/?(\.\w*rc|\.profile|\.bash_profile|\.zprofile|\.gitconfig|\/etc\/)/i, risk: 'high', reason: 'modifies shell or system configuration' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node)\b|iex\s*\(|Invoke-Expression/i, risk: 'high', reason: 'pipes a downloaded script into a shell' },
  { re: /\b(brew|apt|apt-get|dnf|yum|pacman|choco|winget|scoop|port)\s+(install|remove|uninstall|upgrade|purge)/i, risk: 'medium', reason: 'installs or removes system packages' },
];

/** One simple command: its real argument vector (quotes removed), as the program receives it. */
interface SimpleCommand {
  words: string[];
  /** Per word: contains a $-expansion or command substitution, so its value is unknown. */
  dynamic: boolean[];
  /** Output redirection targets. */
  outputs: { target: string; dynamic: boolean }[];
}

/**
 * A small shell lexer: splits on control operators outside quotes, removes quotes and
 * backslash escapes, records redirections, and treats $(...) / backticks as separate
 * commands. `normalized` is the command with quoting removed, for the pattern rules.
 */
export function parseShell(command: string): { commands: SimpleCommand[]; normalized: string } {
  const commands: SimpleCommand[] = [];
  let cur: SimpleCommand = { words: [], dynamic: [], outputs: [] };
  let word = '';
  let inWord = false;
  let dyn = false;
  let pending: 'out' | 'in' | null = null;
  let norm = '';
  const nested: SimpleCommand[] = [];
  const endWord = () => {
    if (!inWord) return;
    if (pending === 'out') cur.outputs.push({ target: word, dynamic: dyn });
    else if (pending !== 'in') {
      cur.words.push(word);
      cur.dynamic.push(dyn);
    }
    pending = null;
    word = '';
    inWord = false;
    dyn = false;
  };
  const endCommand = () => {
    endWord();
    pending = null;
    if (cur.words.length || cur.outputs.length) commands.push(cur);
    cur = { words: [], dynamic: [], outputs: [] };
  };
  const n = command.length;
  for (let i = 0; i < n; i++) {
    const c = command[i];
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      word += command.slice(i + 1, end);
      norm += command.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
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
          const inner = parseShell(command.slice(j + 2, end));
          nested.push(...inner.commands);
          word += '$(…)';
          norm += `$(${inner.normalized})`;
          dyn = true;
          j = end;
          continue;
        }
        if (command[j] === '`') {
          let end = j + 1;
          while (end < n && command[end] !== '`') end += command[end] === '\\' ? 2 : 1;
          const inner = parseShell(command.slice(j + 1, end));
          nested.push(...inner.commands);
          word += '$(…)';
          norm += `\`${inner.normalized}\``;
          dyn = true;
          j = end;
          continue;
        }
        if (command[j] === '$') dyn = true;
        word += command[j];
        norm += command[j];
      }
      i = j;
      continue;
    }
    if (c === '$' && command[i + 1] === "'") {
      // $'...' (ANSI-C quoting): decode it, so escapes can't hide a command name.
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
      const inner = parseShell(command.slice(i + 2, j));
      nested.push(...inner.commands);
      if (c !== '$') endWord();
      word += '$(…)';
      dyn = true;
      inWord = true;
      norm += `${c}(${inner.normalized})`;
      i = j;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < n && command[j] !== '`') j += command[j] === '\\' ? 2 : 1;
      const inner = parseShell(command.slice(i + 1, j));
      nested.push(...inner.commands);
      word += '$(…)';
      dyn = true;
      inWord = true;
      norm += `\`${inner.normalized}\``;
      i = j;
      continue;
    }
    if (c === '$') {
      dyn = true;
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
      }
      pending = 'out';
      continue;
    }
    if (c === '<') {
      endWord();
      let op = c;
      while (command[i + 1] === '<') op += command[++i];
      norm += op;
      pending = 'in';
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      endCommand();
      norm += c;
      continue;
    }
    // Unquoted *, ?, [ and {a,b} expand to names only known when the command runs.
    if (c === '*' || c === '?' || c === '[' || c === '{') dyn = true;
    word += c;
    norm += c;
    inWord = true;
  }
  endCommand();
  return { commands: [...commands, ...nested], normalized: norm };
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
function readOnlyForm(cmd: string, args: string[]): boolean {
  const positional = args.filter((w) => !w.startsWith('-'));
  switch (cmd) {
    case 'sort':
    case 'tree':
      return !args.some((w) => /^-o|^--output/.test(w) || (cmd === 'sort' && /^-[a-zA-Z]*o/.test(w)));
    case 'uniq':
      return positional.length <= 1; // uniq IN OUT writes OUT
    case 'xxd':
      return !args.some((w) => /^-r|^-revert/.test(w)) && positional.length <= 1;
    case 'yq':
      return !args.some((w) => /^-[a-zA-Z]*i|^--inplace/.test(w));
    case 'rg':
      return !args.some((w) => /^--pre(=|$)/.test(w));
    case 'fd':
      return !args.some((w) => /^-[a-zA-Z]*[xX]|^--exec/.test(w));
    case 'date':
      return positional.every((w) => w.startsWith('+')) && !args.some((w) => /^-[a-zA-Z]*s|^--set/.test(w));
    case 'hostname':
      return positional.length === 0;
    case 'find':
      return !args.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(w));
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
const SAFE_ASSIGNMENT = /^(LC_[A-Z]+|LANG|LANGUAGE|TZ|NO_COLOR|FORCE_COLOR|COLUMNS|LINES|TERM|PAGER|GIT_PAGER)=/;
/** Where the real system utilities live: a path anywhere else could be any program. */
const SYSTEM_BIN = /^\/(usr\/)?s?bin\/[^/]+$/;

/**
 * Whether a bare program name (no slash) runs a program agents can't have put there. Only the host
 * knows its PATH and which folders agents may write, so it supplies this; without it (the cloud VM,
 * which the agent owns anyway) names are taken at face value.
 */
export type ProgramTrust = (name: string) => boolean;

/** The program a command runs: the first word after leading VAR=value assignments. */
function program(c: SimpleCommand): { words: string[]; dynamic: boolean[]; unsafeEnv: boolean } {
  let k = 0;
  while (k < c.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(c.words[k])) k++;
  const unsafeEnv = c.words.slice(0, k).some((w) => !SAFE_ASSIGNMENT.test(w));
  return { words: c.words.slice(k), dynamic: c.dynamic.slice(k), unsafeEnv };
}

function commandIsReadOnly(c: SimpleCommand, trust?: ProgramTrust): boolean {
  if (c.outputs.some((o) => o.dynamic || !SAFE_OUTPUTS.has(o.target))) return false;
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
  if (cmd === 'git') return GIT_READ.test(line) && !args.some((a) => /^(--output(=|$)|-o$|-o.|--output-directory)/.test(a));
  if (!READ_ONLY.has(cmd)) return false;
  return readOnlyForm(cmd, args);
}

/** True when every command in the line is a known read-only form with fully known arguments. */
export function isReadOnlyCommand(command: string, trust?: ProgramTrust): boolean {
  const { commands } = parseShell(command);
  return commands.length > 0 && commands.every((c) => commandIsReadOnly(c, trust) && !c.dynamic.some(Boolean));
}

export function assessShell(command: string, runtime: Runtime, trust?: ProgramTrust): Assessment {
  let risk: Risk = 'low';
  let reason: string | undefined;
  // Rules see both the text as written and with quoting removed ("rm" -rf ~ is rm -rf ~).
  const { commands, normalized } = parseShell(command);
  for (const rule of RULES) {
    if (rule.re.test(command) || rule.re.test(normalized)) {
      if (rule.block) return { risk: 'critical', reason: rule.reason, blocked: `Blocked: this command ${rule.reason}.` };
      if (riskRank(rule.risk) > riskRank(risk)) {
        risk = rule.risk;
        reason = rule.reason;
      }
    }
  }
  // A program whose name is only known when the command runs (from $VAR, $(...), a wildcard)
  // can't be judged: ask, like for anything else that could do real damage.
  if (riskRank(risk) < riskRank('high') && commands.some((c) => program(c).dynamic[0])) {
    risk = 'high';
    reason = 'runs a program whose name is only known when it runs';
  }
  if (risk === 'low') {
    const ro = commands.every((c) => commandIsReadOnly(c, trust));
    if (!ro) {
      risk = 'medium';
      reason = commands.every((c) => commandIsReadOnly(c))
        ? 'runs a program found in a folder agents can write to, so it may not be the usual one'
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

export function assessBrowser(action: string, target: BrowserTarget | undefined, runtime: Runtime): Assessment {
  const text = `${target?.label ?? ''}`;
  if (action === 'type') {
    const t = `${target?.inputType ?? ''} ${target?.autocomplete ?? ''} ${text}`.toLowerCase();
    if (/password|cc-|card|cvc|cvv|security code|one-time|otp|2fa|passcode|ssn|social security|iban|routing/.test(t)) {
      return { risk: 'critical', reason: 'enters credentials or payment details', blocked: 'Blocked: agents never type passwords, card numbers or other credentials. Ask the user to do this step.' };
    }
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
  if (/(^|[\\/])\.(ssh|aws|gnupg|kube|docker)([\\/]|$)|\.env(\.|$)|id_rsa|credentials/i.test(path)) {
    return { risk: 'critical', reason: 'writes a credentials file' };
  }
  if (runtime === 'cloud') return { risk: 'low' };
  return { risk: existing ? 'medium' : 'medium', reason: existing ? 'overwrites a file on your computer' : 'creates a file on your computer' };
}

export function assessGithub(method: string, path: string): Assessment {
  const m = method.toUpperCase();
  if (m === 'GET') return { risk: 'low' };
  if (/\/(collaborators|keys|hooks|secrets|actions\/secrets|deployments|transfer|branches\/[^/]+\/protection)/.test(path) || m === 'DELETE') {
    return { risk: 'critical', reason: 'changes repository security, access or deletes data' };
  }
  if (/\/merge$|\/pulls\/\d+\/merge/.test(path)) return { risk: 'high', reason: 'merges a pull request' };
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
      const a = assessShell(s('command'), runtime, context.trustedProgram);
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
      if (/(^|[\\/])\.(ssh|aws|gnupg)([\\/]|$)|id_rsa|\.env$|credentials|keychain/i.test(s('path'))) {
        return { risk: 'critical', reason: 'reads a credentials file' };
      }
      return { risk: 'low' };
    case 'computer.list_files':
    case 'computer.shell_status':
    case 'computer.share_file':
      return { risk: 'low' };
    case 'browser.click':
    case 'browser.type':
    case 'browser.press': {
      const action = name.split('.')[1];
      // press acts on the focused element; only keys that can activate or submit it matter.
      if (action === 'press' && !isActivatingKey(s('key'))) return { risk: 'low' };
      const target = context.browserTarget;
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
      return assessGithub(s('method') || 'GET', s('path'));
    case 'screen.capture':
      return { risk: 'high', reason: 'captures your screen' };
    case 'memory.remember':
    case 'memory.forget':
    case 'task.update_plan':
    case 'task.ask_user':
    case 'task.notify':
    case 'browser.snapshot':
    case 'browser.screenshot':
    case 'browser.scroll':
    case 'browser.back':
      return { risk: 'low' };
    default:
      // A server's readOnlyHint is its own claim, so it never lowers the risk.
      if (name.startsWith('mcp_')) return { risk: 'high', reason: context.mcpReadOnly ? 'calls a connected service (the service says this is read-only)' : 'calls a connected service' };
      return { risk: 'medium', reason: 'unrecognised tool' };
  }
}

/**
 * Keys that can click, submit or toggle the focused element (alone or with
 * modifiers). A literal " " is Space; "" means the controller's default, Enter.
 */
export function isActivatingKey(key: string): boolean {
  if (key === '' || key === ' ' || key.endsWith('+ ') || key.endsWith('+')) return true;
  const last = key.split('+').pop()!.trim().toLowerCase();
  return /^(enter|return|numpadenter|space|spacebar)$/.test(last);
}

export { bump as bumpRisk };
