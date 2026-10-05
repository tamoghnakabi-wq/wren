import type { AgentTools, Runtime, ToolSpec } from './types';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const bool = (description: string) => ({ type: 'boolean', description });

export const NAMESPACE_DESCRIPTIONS: Record<string, string> = {
  computer: "Shell and files on the agent's computer.",
  browser: 'A real Chromium browser the agent controls.',
  web: 'Fetch web pages as readable text.',
  github: 'GitHub REST API with the user-provided token.',
  memory: 'Long-term notes the agent keeps about the user and their work.',
  task: 'Planning, progress, notifications and questions for the user.',
  screen: "Capture the user's screen (desktop only).",
};

function computerTools(runtime: Runtime): ToolSpec[] {
  const where =
    runtime === 'cloud'
      ? "the agent's own persistent Linux computer (Ubuntu, sudo available, work in /workspace)"
      : "the user's computer, restricted to folders the user allowed";
  return [
    {
      namespace: 'computer',
      name: 'shell',
      description: `Run a shell command on ${where}. Returns stdout/stderr and exit code. Use background=true for servers or very long jobs, then poll with shell_status. Background jobs belong to this task: they are stopped when the task ends or is stopped.`,
      parameters: obj(
        {
          command: str('The command line to run (bash on Linux/macOS, PowerShell on Windows).'),
          cwd: str('Working directory. Defaults to the workspace root.'),
          timeout_sec: int('Max seconds to wait (default 120, max 1800).'),
          background: bool('Start and return immediately with a job id.'),
        },
        ['command'],
      ),
    },
    {
      namespace: 'computer',
      name: 'shell_status',
      description: 'Check a background shell job: returns status and the latest output.',
      parameters: obj({ job_id: str('Job id returned by shell.'), wait_sec: int('Seconds to wait for completion (max 600).') }, ['job_id']),
    },
    {
      namespace: 'computer',
      name: 'read_file',
      description: 'Read a UTF-8 text file. Large files are returned in pages.',
      parameters: obj({ path: str('File path.'), offset: int('Line to start at (1-based).'), limit: int('Max lines (default 400).') }, ['path']),
    },
    {
      namespace: 'computer',
      name: 'write_file',
      description: 'Create or overwrite a text file (parent folders are created).',
      parameters: obj({ path: str('File path.'), content: str('Full file content.') }, ['path', 'content']),
    },
    {
      namespace: 'computer',
      name: 'edit_file',
      description: 'Replace an exact, unique snippet in a text file.',
      parameters: obj(
        { path: str('File path.'), old_text: str('Exact text to find (must be unique).'), new_text: str('Replacement text.') },
        ['path', 'old_text', 'new_text'],
      ),
    },
    {
      namespace: 'computer',
      name: 'list_files',
      description: 'List files and folders (depth 1-3).',
      parameters: obj({ path: str('Folder path.'), depth: int('Depth 1-3 (default 1).') }, ['path']),
    },
    {
      namespace: 'computer',
      name: 'share_file',
      description: 'Publish a file from the computer to the user as a downloadable artifact (reports, exports, images).',
      parameters: obj({ path: str('File path.'), name: str('Display name (optional).') }, ['path']),
    },
  ];
}

const browserTools: ToolSpec[] = [
  {
    namespace: 'browser',
    name: 'navigate',
    description: 'Open a URL in the browser. Returns the page title and a text snapshot with element refs.',
    parameters: obj({ url: str('Absolute URL.') }, ['url']),
  },
  {
    namespace: 'browser',
    name: 'snapshot',
    description: 'Get the current page as text with numbered interactive element refs like [e12].',
    parameters: obj({}),
  },
  {
    namespace: 'browser',
    name: 'click',
    description: 'Click an element by ref from the latest snapshot.',
    parameters: obj({ ref: str('Element ref, e.g. e12.') }, ['ref']),
  },
  {
    namespace: 'browser',
    name: 'type',
    description: 'Type into an input by ref. Never type passwords, card numbers or other credentials; ask the user instead.',
    parameters: obj({ ref: str('Element ref.'), text: str('Text to type.'), submit: bool('Press Enter afterwards.') }, ['ref', 'text']),
  },
  {
    namespace: 'browser',
    name: 'press',
    description: 'Press a key (Enter, Escape, Tab, ArrowDown, PageDown...).',
    parameters: obj({ key: str('Key name.') }, ['key']),
  },
  {
    namespace: 'browser',
    name: 'scroll',
    description: 'Scroll the page.',
    parameters: obj({ direction: { type: 'string', enum: ['up', 'down'] }, amount: int('Screens to scroll (default 1).') }, ['direction']),
  },
  {
    namespace: 'browser',
    name: 'screenshot',
    description: 'Take a screenshot of the page to look at it.',
    parameters: obj({ full_page: bool('Capture the full page instead of the viewport.') }),
  },
  {
    namespace: 'browser',
    name: 'back',
    description: 'Go back in history.',
    parameters: obj({}),
  },
];

const webTools: ToolSpec[] = [
  {
    namespace: 'web',
    name: 'fetch',
    description: 'Fetch a public web page or JSON endpoint and return readable text (max ~40k chars). Prefer this over the browser for reading.',
    parameters: obj({ url: str('http(s) URL.'), max_chars: int('Max characters to return.') }, ['url']),
  },
];

const githubTools: ToolSpec[] = [
  {
    namespace: 'github',
    name: 'request',
    description:
      'Call the GitHub REST API (https://api.github.com) with the connected token. Example: GET /user/repos, POST /repos/{owner}/{repo}/issues. Write requests need approval.',
    parameters: obj(
      {
        method: { type: 'string', enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] },
        path: str('API path starting with /.'),
        body: { type: 'object', description: 'JSON body for write requests.', additionalProperties: true },
      },
      ['method', 'path'],
    ),
  },
];

const memoryTools: ToolSpec[] = [
  {
    namespace: 'memory',
    name: 'remember',
    description: 'Save a durable fact or preference for future sessions (one short sentence). Do not store secrets.',
    parameters: obj({ fact: str('The fact to remember.') }, ['fact']),
  },
  {
    namespace: 'memory',
    name: 'forget',
    description: 'Delete a saved memory by id.',
    parameters: obj({ id: str('Memory id.') }, ['id']),
  },
];

const taskTools = (notify: boolean): ToolSpec[] => [
  {
    namespace: 'task',
    name: 'update_plan',
    description: 'Show the user your step-by-step plan and progress. Call at the start of multi-step work and whenever a step changes.',
    parameters: obj(
      {
        items: {
          type: 'array',
          items: obj({ text: str('Step.'), status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, ['text', 'status']),
        },
      },
      ['items'],
    ),
  },
  {
    namespace: 'task',
    name: 'ask_user',
    description: 'Pause and ask the user a question when you genuinely need a decision or information. The run resumes when they answer.',
    parameters: obj({ question: str('The question.') }, ['question']),
  },
  ...(notify
    ? [
        {
          namespace: 'task',
          name: 'notify',
          description: "Send a push notification to the user's phone/desktop (use for important findings in long tasks, not every step).",
          parameters: obj({ title: str('Short title.'), body: str('Message.') }, ['title', 'body']),
        },
      ]
    : []),
];

const screenTools: ToolSpec[] = [
  {
    namespace: 'screen',
    name: 'capture',
    description: "Capture a screenshot of the user's main display (requires approval).",
    parameters: obj({}),
  },
];

export interface CatalogOptions {
  runtime: Runtime;
  tools: AgentTools;
  githubConnected: boolean;
  extra?: ToolSpec[]; // MCP tools
}

export function toolCatalog(opts: CatalogOptions): ToolSpec[] {
  const out: ToolSpec[] = [];
  if (opts.tools.computer) out.push(...computerTools(opts.runtime));
  if (opts.tools.browser) out.push(...browserTools);
  if (opts.tools.web) out.push(...webTools);
  if (opts.tools.github && opts.githubConnected) out.push(...githubTools);
  if (opts.tools.memory) out.push(...memoryTools);
  out.push(...taskTools(opts.tools.notify));
  if (opts.tools.screen && opts.runtime === 'desktop') out.push(...screenTools);
  if (opts.extra) out.push(...opts.extra);
  return out;
}

export const qualified = (t: { namespace: string; name: string }) => `${t.namespace}.${t.name}`;

/** Human-readable one-liner for the activity timeline. */
export function describeCall(name: string, args: Record<string, unknown>): string {
  const a = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
  const clip = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  switch (name) {
    case 'computer.shell':
      return `Run \`${clip(a('command'), 120)}\``;
    case 'computer.shell_status':
      return `Check background job ${a('job_id')}`;
    case 'computer.read_file':
      return `Read ${a('path')}`;
    case 'computer.write_file':
      return `Write ${a('path')}`;
    case 'computer.edit_file':
      return `Edit ${a('path')}`;
    case 'computer.list_files':
      return `List ${a('path')}`;
    case 'computer.share_file':
      return `Share ${a('name') || a('path')}`;
    case 'browser.navigate':
      return `Open ${clip(a('url'))}`;
    case 'browser.snapshot':
      return 'Read the page';
    case 'browser.click':
      return `Click ${a('ref')}`;
    case 'browser.type':
      return `Type into ${a('ref')}`;
    case 'browser.press':
      return `Press ${a('key')}`;
    case 'browser.scroll':
      return `Scroll ${a('direction')}`;
    case 'browser.screenshot':
      return 'Take a screenshot';
    case 'browser.back':
      return 'Go back';
    case 'web.fetch':
      return `Fetch ${clip(a('url'))}`;
    case 'github.request':
      return `GitHub ${a('method')} ${clip(a('path'))}`;
    case 'memory.remember':
      return `Remember: ${clip(a('fact'))}`;
    case 'memory.forget':
      return 'Forget a memory';
    case 'task.update_plan':
      return 'Update plan';
    case 'task.ask_user':
      return `Ask: ${clip(a('question'))}`;
    case 'task.notify':
      return `Notify: ${clip(a('title'))}`;
    case 'screen.capture':
      return 'Capture the screen';
    default:
      return name.replace('.', ' · ');
  }
}
