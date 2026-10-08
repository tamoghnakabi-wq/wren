// Shared types for the Wren agent runtime. The same loop runs in Vercel
// Functions (cloud runs) and in the desktop app's main process (local runs).

export type Runtime = 'cloud' | 'desktop';
export type Autonomy = 'careful' | 'balanced' | 'autonomous';
export type Risk = 'low' | 'medium' | 'high' | 'critical';

/**
 * Where an agent's model access comes from.
 * - openai / anthropic / xai / gateway: the user's own API key connection (server-side).
 * - platform: the operator's Vercel AI Gateway credits (owner-enabled only).
 * - chatgpt: the user's ChatGPT plan via official "Sign in with ChatGPT" on a desktop device.
 * - local: an OpenAI-compatible server on the desktop device (LM Studio, Ollama...).
 * - claude-code / grok-build: the official CLIs on the desktop, signed in by the user.
 */
export type ModelSource =
  | 'openai'
  | 'anthropic'
  | 'xai'
  | 'gateway'
  | 'platform'
  | 'chatgpt'
  | 'local'
  | 'claude-code'
  | 'grok-build';

export const DESKTOP_ONLY_SOURCES: ModelSource[] = ['chatgpt', 'local', 'claude-code', 'grok-build'];
export const ENGINE_SOURCES: ModelSource[] = ['claude-code', 'grok-build'];

export interface ModelRef {
  source: ModelSource;
  model: string;
  connectionId?: string;
  effort?: 'low' | 'medium' | 'high';
}

export interface AgentTools {
  computer: boolean; // shell + files on the agent's computer
  browser: boolean;
  web: boolean; // fetch + provider web search
  github: boolean;
  memory: boolean;
  notify: boolean;
  screen: boolean; // desktop screen capture
  mcp: string[]; // connection ids of MCP servers
}

export const DEFAULT_TOOLS: AgentTools = {
  computer: true,
  browser: true,
  web: true,
  github: false,
  memory: true,
  notify: true,
  screen: false,
  mcp: [],
};

export interface AgentConfig {
  id: string;
  name: string;
  instructions: string;
  model: ModelRef;
  runtime: Runtime;
  autonomy: Autonomy;
  tools: AgentTools;
  memoryEnabled: boolean;
}

// ------------------------------------------------------------------ events

export type EventType = 'message' | 'tool' | 'status' | 'plan' | 'reasoning';

export type ToolStatus =
  | 'pending'
  | 'awaiting_approval'
  | 'awaiting_input'
  | 'running'
  | 'done'
  | 'error'
  | 'denied'
  | 'cancelled';

export interface ImageRef {
  /** artifact id (persisted) or inline data for the current turn only */
  artifactId?: string;
  mime: string;
  /** base64 without data: prefix; only kept transiently */
  data?: string;
}

export interface RawTurn {
  format: 'responses' | 'anthropic' | 'chat';
  /** provider-native output items / content blocks for faithful replay */
  items: unknown[];
}

export interface MessageData {
  role: 'user' | 'assistant';
  text: string;
  images?: ImageRef[];
  attachments?: { artifactId: string; name: string; mime: string; size: number }[];
  raw?: RawTurn;
  model?: string;
  source?: string;
  /** Tool calls parsed from this turn, so a crash before they were saved can be repaired. */
  calls?: { callId: string; namespace: string; name: string; args: Record<string, unknown>; argsError?: string }[];
}

export interface ToolCallData {
  callId: string;
  name: string; // fully-qualified "namespace.name"
  args: Record<string, unknown>;
  title: string;
  risk: Risk;
  turnId?: string; // assistant message event id that issued the call
  approvalId?: string;
  result?: ToolResult;
  background?: { kind: string; handle: string; startedAt: number };
  startedAt?: number;
  endedAt?: number;
  engine?: boolean; // emitted by an external CLI engine (display only)
  /** The page element a browser action was assessed (and approved) against. */
  /**
   * The browser element a click/type/press was assessed (and approved) against: the exact DOM
   * node (elementId, held by the browser controller and never visible to the page), the page it
   * was on, and where a link or form leads.
   */
  target?: { label?: string; role?: string; inputType?: string; autocomplete?: string; elementId?: string; url?: string; href?: string; form?: string };
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  images?: ImageRef[];
  artifacts?: { id: string; name: string }[];
  meta?: Record<string, unknown>;
}

export interface StatusData {
  text: string;
  level?: 'info' | 'warn' | 'error' | 'success';
  code?: string;
}

export interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'done';
  /** The engine's own id for the item (Claude Code's task list), so a later turn can update it. */
  id?: string;
}

export interface SessionEvent<T = unknown> {
  id: string;
  seq?: number;
  runId?: string | null;
  type: EventType;
  status?: string | null;
  data: T;
  createdAt?: string;
}

// ------------------------------------------------------------------ model I/O

export interface ToolSpec {
  namespace: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface HostedTool {
  type: 'web_search';
}

export interface ModelRequest {
  model: string;
  instructions: string;
  events: SessionEvent[]; // transcript source
  tools: ToolSpec[];
  hosted: HostedTool[];
  effort?: 'low' | 'medium' | 'high';
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ModelToolCall {
  callId: string;
  namespace: string;
  name: string;
  args: Record<string, unknown>;
  argsError?: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface ModelTurn {
  text: string;
  toolCalls: ModelToolCall[];
  raw: RawTurn;
  usage: ModelUsage;
  stopReason: 'end' | 'tool_calls' | 'max_tokens' | 'refusal' | 'other';
  webSearches?: number;
}

export type ModelStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call_started'; name: string }
  | { type: 'web_search'; query?: string };

export interface ModelClient {
  readonly label: string;
  stream(req: ModelRequest, onEvent: (e: ModelStreamEvent) => void): Promise<ModelTurn>;
}

export class ModelError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly code: string | undefined,
    public readonly retryable: boolean,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

// ------------------------------------------------------------------ OpenAI access preference

/** How the user prefers to pay for OpenAI models (Settings → Model access). */
export type OpenAIAccess = 'chatgpt' | 'api';

export interface OpenAIRouteInput {
  preference: OpenAIAccess;
  allowFallback: boolean;
  runtime: Runtime;
  /** The desktop device has a valid "Sign in with ChatGPT" registration with plan usage. */
  chatgptAvailable: boolean;
  apiKeyAvailable: boolean;
}

export type OpenAIRoute = { via: 'chatgpt' | 'api'; note?: string } | { error: string };

/**
 * ChatGPT-plan usage is only permitted from the locally hosted (desktop) app,
 * so cloud runs always use the API key. On the desktop the user's preference
 * decides, with the other path as an explicit fallback.
 */
export function resolveOpenAIRoute(i: OpenAIRouteInput): OpenAIRoute {
  if (i.runtime === 'cloud') {
    if (i.apiKeyAvailable) return { via: 'api', note: i.preference === 'chatgpt' ? 'Cloud runs use your OpenAI API key; ChatGPT plan usage is only available on your own computer.' : undefined };
    return { error: 'This agent runs in the cloud, where OpenAI only allows API-key billing. Add an OpenAI API key in Connections, or run the agent on your computer to use your ChatGPT plan.' };
  }
  if (i.preference === 'chatgpt') {
    if (i.chatgptAvailable) return { via: 'chatgpt' };
    if (i.apiKeyAvailable && i.allowFallback) return { via: 'api', note: 'ChatGPT is not signed in on this computer, so your API key was used.' };
    return { error: 'Sign in with ChatGPT in the Wren desktop app on this computer (Settings → Model access), or switch OpenAI access to API key.' };
  }
  if (i.apiKeyAvailable) return { via: 'api' };
  if (i.chatgptAvailable && i.allowFallback) return { via: 'chatgpt' };
  return { error: 'Add an OpenAI API key in Connections, or switch OpenAI access to your ChatGPT plan.' };
}
