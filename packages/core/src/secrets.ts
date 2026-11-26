// Secrets an agent asks the user for (task.request_secret): an API key, token or password its commands need,
// typed into a private card instead of the conversation. The value never goes to the model: the task's commands
// get it as an environment variable of the agent's chosen name, and Wren blanks it out of everything the task
// saves (`scrubSecrets`), so a command that prints it doesn't put it in the conversation.

export interface TaskSecret {
  name: string;
  value: string;
}

/** How long a saved secret is kept for its task. */
export const SECRET_TTL_MS = 24 * 3_600_000;
/** The longest value a card takes. */
export const SECRET_MAX_CHARS = 8192;

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/**
 * Names that change how programs start or where they connect (a value there could run code or reroute
 * traffic), or that Wren and the shell set themselves.
 */
const RESERVED = /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TMPDIR|TMP|TEMP|TERM|LANG|IFS|ENV|PS[0-9]|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|HISTFILE|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NPM_CONFIG_.*|PYTHON.*|PERL5.*|PERLLIB|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|CLASSPATH|GEM_.*|GOPATH|GOFLAGS|EDITOR|VISUAL|PAGER|GIT_.*|SSH_.*|GPG_.*|LD_.*|DYLD_.*|BASH_.*|ZDOTDIR|XDG_.*|LC_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|FTP_PROXY|SSL_CERT_.*|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|DOCKER_.*|KUBECONFIG|WREN_.*|CLAUDE_.*|ANTHROPIC_.*|CODEX_.*|GROK_.*|ELECTRON_.*|TMUX.*|DISPLAY|SUDO_.*)$/;

/** Why a name can't hold a secret, or null when it can. */
export function secretNameProblem(name: string): string | null {
  if (!NAME.test(name)) return 'Name it like an environment variable: capital letters, digits and _, starting with a letter (e.g. STRIPE_API_KEY), at most 64 characters.';
  if (RESERVED.test(name)) return `${name} is a name programs or Wren use for something else. Pick a name of its own (e.g. MY_${name.replace(/^_+/, '')}).`;
  return null;
}

/** Values this short aren't blanked out (they would match ordinary text); the card asks for at least this. */
export const SECRET_MIN_CHARS = 4;

/**
 * A copy of `data` with every secret's value replaced by `[secret NAME]`, wherever it appears in strings
 * (searched in the JSON form, so values with quotes or backslashes match as they are stored).
 */
export function scrubSecrets<T>(data: T, secrets: TaskSecret[]): T {
  const usable = secrets.filter((s) => s.value.length >= SECRET_MIN_CHARS);
  if (!usable.length || data === undefined) return data;
  let json = JSON.stringify(data);
  let changed = false;
  // Longest first, so a secret that contains another is replaced whole.
  for (const s of [...usable].sort((a, b) => b.value.length - a.value.length)) {
    const needle = JSON.stringify(s.value).slice(1, -1);
    if (!json.includes(needle)) continue;
    json = json.split(needle).join(`[secret ${s.name}]`);
    changed = true;
  }
  return changed ? (JSON.parse(json) as T) : data;
}

/** The secrets as environment variables for a command, keeping only names a secret may have. */
export function taskSecretEnv(secrets?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(secrets ?? {})) if (!secretNameProblem(name) && typeof value === 'string') out[name] = value;
  return out;
}
