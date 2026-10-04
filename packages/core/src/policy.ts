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
const GH_READ = /^gh\s+(pr|issue|repo|run|release|workflow)\s+(list|view|status|diff|checks)\b|^gh\s+(auth\s+status|api\s+(?!.*((-X|--method)\s*(POST|PUT|PATCH|DELETE)|\s(-f|-F|--field|--raw-field|--input)(\s|=))))/i;
/** Read commands that can still write a file through an option. */
const WRITE_OPTION = /\s(--output(=|\s)|-o\s|--output-directory)/;

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
  { re: /\bgh\s+(pr\s+(create|merge|close|comment|review|edit)|issue\s+(create|close|comment|edit|delete)|repo\s+(create|delete|archive|edit|rename)|release\s+(create|delete|upload)|api\s+.*((-X|--method)\s*(POST|PUT|PATCH|DELETE)|\s(-f|-F|--field|--raw-field|--input)(\s|=))|secret|workflow\s+run)/i, risk: 'high', reason: 'changes things on GitHub' },
  { re: /\b(npm|pnpm|yarn)\s+publish|\bcargo\s+publish|\btwine\s+upload|\bgem\s+push|\bvercel\s+(deploy\s+.*--prod|--prod|promote|remove|rm)|\bnetlify\s+deploy\s+--prod|\bfly\s+deploy|\bterraform\s+(apply|destroy)|\bkubectl\s+(apply|delete)|\bheroku\b/i, risk: 'high', reason: 'publishes or deploys' },
  { re: /\b(curl|wget|http|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s|--upload-file|-F\s|-T\s|-Method\s+(Post|Put|Patch|Delete))/i, risk: 'high', reason: 'sends data to a server' },
  { re: new RegExp(`${CMD}(ssh|scp|rsync|sftp|ftp|telnet|nc|ncat|socat)\\s`), risk: 'high', reason: 'connects to another machine' },
  { re: new RegExp(`${CMD}(kill|killall|pkill|taskkill|Stop-Process)\\b`, 'i'), risk: 'high', reason: 'stops processes' },
  { re: new RegExp(`${CMD}(sendmail|mail|mutt|osascript)\\b`), risk: 'high', reason: 'automates apps or sends mail' },
  { re: /(>|>>)\s*~?\/?(\.\w*rc|\.profile|\.bash_profile|\.zprofile|\.gitconfig|\/etc\/)/i, risk: 'high', reason: 'modifies shell or system configuration' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node)\b|iex\s*\(|Invoke-Expression/i, risk: 'high', reason: 'pipes a downloaded script into a shell' },
  { re: /\b(brew|apt|apt-get|dnf|yum|pacman|choco|winget|scoop|port)\s+(install|remove|uninstall|upgrade|purge)/i, risk: 'medium', reason: 'installs or removes system packages' },
];

/** Split a command line into rough segments on shell control operators. */
function segments(command: string): string[] {
  return command
    .split(/\|\||&&|;|\||\n|`|\$\(/)
    .map((s) => s.trim().replace(/^\(+|\)+$/g, '').trim())
    .filter(Boolean);
}

/** True when an output redirection targets a real file (not /dev/null or another descriptor). */
function writesThroughRedirect(seg: string): boolean {
  for (const m of seg.matchAll(/(?:&>>?|\d?>>?)\s*([^\s;|&]*)(&?\d*)/g)) {
    const target = m[1] || m[2];
    if (!target) continue;
    if (/^&\d+$|^&$/.test(target) || /^&?\d+$/.test(m[2]) && !m[1]) continue;
    if (target === '/dev/null' || target === '/dev/stdout' || target === '/dev/stderr') continue;
    return true;
  }
  return false;
}

function segmentIsReadOnly(seg: string): boolean {
  if (writesThroughRedirect(seg)) return false;
  if (VERSION_ONLY.test(seg) || GH_READ.test(seg)) return true;
  if (GIT_READ.test(seg)) return !WRITE_OPTION.test(seg);
  const first = seg.split(/\s+/)[0].toLowerCase().replace(/^.*[\\/]/, '');
  if (!READ_ONLY.has(first)) return false;
  if (first === 'find' && /\s-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/.test(seg)) return false;
  if ((first === 'sort' || first === 'uniq' || first === 'tree') && WRITE_OPTION.test(seg)) return false;
  return true;
}

export function assessShell(command: string, runtime: Runtime): Assessment {
  let risk: Risk = 'low';
  let reason: string | undefined;
  for (const rule of RULES) {
    if (rule.re.test(command)) {
      if (rule.block) return { risk: 'critical', reason: rule.reason, blocked: `Blocked: this command ${rule.reason}.` };
      if (riskRank(rule.risk) > riskRank(risk)) {
        risk = rule.risk;
        reason = rule.reason;
      }
    }
  }
  if (risk === 'low') {
    const ro = segments(command).every(segmentIsReadOnly);
    if (!ro) {
      risk = 'medium';
      reason = 'runs a program that can change files';
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

/**
 * Assess a tool call. `context` carries lookups the host can provide (e.g. the
 * browser element behind a ref, whether a file exists).
 */
export function assessCall(
  name: string,
  args: Record<string, unknown>,
  runtime: Runtime,
  context: { browserTarget?: BrowserTarget; fileExists?: boolean; mcpReadOnly?: boolean; unsandboxed?: boolean } = {},
): Assessment {
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
  switch (name) {
    case 'computer.shell': {
      const a = assessShell(s('command'), runtime);
      // Without an OS sandbox (Windows) anything that can change files asks in balanced mode.
      if (context.unsandboxed && a.risk === 'medium') return { risk: 'high', reason: 'runs a program on your computer (not sandboxed on Windows)' };
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

/** Keys that can click, submit or toggle the focused element (alone or with modifiers). */
export function isActivatingKey(key: string): boolean {
  const last = key.split('+').pop()!.trim();
  return key === '' || /^(enter|return|numpadenter| |space|spacebar)$/i.test(last) || /^(enter|return)$/i.test(key);
}

export { bump as bumpRisk };
