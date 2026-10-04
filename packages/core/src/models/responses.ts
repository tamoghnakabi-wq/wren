import { buildTurns, clipMiddle, flatName, limitImages, parseArgs, trimOutputs, unflatName, type NeutralTurn } from '../transcript';
import type { ImageRef, ModelClient, ModelRequest, ModelStreamEvent, ModelToolCall, ModelTurn, ToolSpec } from '../types';
import { ModelError } from '../types';
import { readSse } from './sse';

// OpenAI Responses API adapter. Used for:
//  - OpenAI with an API key
//  - the user's ChatGPT plan via "Sign in with ChatGPT" (desktop only; the
//    preview route requires store:false, stream:true, namespaced tools and
//    rejects a list of optional fields)
//  - xAI (Responses-compatible) and Vercel AI Gateway's OpenResponses endpoint

export interface ResponsesConfig {
  origin: string; // 'openai' | 'chatgpt' | 'xai' | 'gateway' | 'platform'
  baseUrl: string;
  headers: () => Promise<Record<string, string>> | Record<string, string>;
  /** Group function tools in `namespace` tools (OpenAI) or flatten names (others). */
  namespaces: boolean;
  /** Apply the ChatGPT-plan preview constraints. */
  chatgptPlan?: boolean;
  /** Request and replay encrypted reasoning items (OpenAI only). */
  encryptedReasoning?: boolean;
  /** Provider supports the hosted `web_search` tool. */
  webSearch?: boolean;
  /** Send a `reasoning` object (effort + summaries). */
  reasoningParams?: boolean;
  loadImage?: (ref: ImageRef) => Promise<{ mime: string; data: string } | null>;
  fetch?: typeof fetch;
  maxImages?: number;
}

type Json = Record<string, unknown>;

export class ResponsesClient implements ModelClient {
  constructor(private readonly cfg: ResponsesConfig) {}

  get label() {
    return this.cfg.origin;
  }

  private toolName(ns: string, name: string) {
    return this.cfg.namespaces ? name : flatName(ns, name);
  }

  // OpenAI reserves some namespace names for its own tools (e.g. `computer`),
  // so ours always go out prefixed and come back stripped.
  private static apiNamespace(ns: string) {
    return `${NS_PREFIX}${ns}`;
  }

  private static ownNamespace(ns: string) {
    return ns.startsWith(NS_PREFIX) ? ns.slice(NS_PREFIX.length) : ns;
  }

  private renderTools(tools: ToolSpec[], hosted: ModelRequest['hosted']): Json[] {
    const out: Json[] = [];
    if (this.cfg.namespaces) {
      const groups = new Map<string, ToolSpec[]>();
      for (const t of tools) groups.set(t.namespace, [...(groups.get(t.namespace) ?? []), t]);
      for (const [ns, list] of groups) {
        out.push({
          type: 'namespace',
          name: ResponsesClient.apiNamespace(ns),
          description: NAMESPACE_HINTS[ns] ?? `${ns} tools`,
          tools: list.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
        });
      }
    } else {
      for (const t of tools) {
        out.push({ type: 'function', name: flatName(t.namespace, t.name), description: t.description, parameters: t.parameters, strict: false });
      }
    }
    if (this.cfg.webSearch) for (const h of hosted) if (h.type === 'web_search') out.push({ type: 'web_search' });
    return out;
  }

  private async renderInput(turns: NeutralTurn[]): Promise<Json[]> {
    const input: Json[] = [];
    const img = async (ref: ImageRef) => {
      if (ref.data) return { mime: ref.mime, data: ref.data };
      return this.cfg.loadImage ? this.cfg.loadImage(ref) : null;
    };
    for (const t of turns) {
      if (t.kind === 'user') {
        const content: Json[] = [];
        if (t.text) content.push({ type: 'input_text', text: t.text });
        for (const ref of t.images) {
          const d = await img(ref);
          if (d) content.push({ type: 'input_image', image_url: `data:${d.mime};base64,${d.data}` });
        }
        if (!content.length) content.push({ type: 'input_text', text: '(empty message)' });
        input.push({ type: 'message', role: 'user', content });
        continue;
      }
      const sameOrigin = t.raw?.format === 'responses' && t.origin === this.cfg.origin;
      if (sameOrigin) {
        for (const item of t.raw!.items as Json[]) {
          if (!item || typeof item !== 'object') continue;
          const type = item.type as string;
          if (type === 'reasoning' && !this.cfg.encryptedReasoning) continue;
          if (!['message', 'function_call', 'reasoning', 'web_search_call'].includes(type)) continue;
          const { id: _id, status: _status, ...rest } = item;
          if (type === 'message') {
            input.push({ type: 'message', role: 'assistant', content: rest.content });
          } else {
            input.push(rest);
          }
        }
      } else {
        if (t.text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t.text }] });
        for (const c of t.calls) {
          input.push({
            type: 'function_call',
            call_id: c.callId,
            name: this.toolName(c.namespace, c.name),
            ...(this.cfg.namespaces ? { namespace: ResponsesClient.apiNamespace(c.namespace) } : {}),
            arguments: JSON.stringify(c.args),
          });
        }
      }
      const imageParts: Json[] = [];
      for (const c of t.calls) {
        input.push({ type: 'function_call_output', call_id: c.callId, output: (c.isError ? 'ERROR: ' : '') + c.output });
        for (const ref of c.images) {
          const d = await img(ref);
          if (d) imageParts.push({ type: 'input_image', image_url: `data:${d.mime};base64,${d.data}` });
        }
      }
      if (imageParts.length) {
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Image output from the tool calls above:' }, ...imageParts] });
      }
    }
    return input;
  }

  async stream(req: ModelRequest, onEvent: (e: ModelStreamEvent) => void): Promise<ModelTurn> {
    const turns = buildTurns(req.events);
    limitImages(turns, this.cfg.maxImages ?? 3);
    trimOutputs(turns);
    const input = await this.renderInput(turns);
    const tools = this.renderTools(req.tools, req.hosted);

    const body: Json = {
      model: req.model,
      instructions: req.instructions,
      input,
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      stream: true,
      store: false,
    };
    if (this.cfg.encryptedReasoning) body.include = ['reasoning.encrypted_content'];
    if (this.cfg.reasoningParams) body.reasoning = { effort: req.effort ?? 'medium', summary: 'auto' };
    if (!this.cfg.chatgptPlan && req.maxOutputTokens) body.max_output_tokens = req.maxOutputTokens;

    try {
      return await this.request(body, req.signal, onEvent);
    } catch (e) {
      // Some Responses-compatible providers reject optional fields; retry once without them.
      if (e instanceof ModelError && e.status === 400 && !this.cfg.chatgptPlan && /reasoning|include|parallel_tool_calls|max_output_tokens|unsupported|unknown parameter/i.test(e.message)) {
        delete body.reasoning;
        delete body.include;
        delete body.parallel_tool_calls;
        delete body.max_output_tokens;
        return this.request(body, req.signal, onEvent);
      }
      throw e;
    }
  }

  private async request(body: Json, signal: AbortSignal | undefined, onEvent: (e: ModelStreamEvent) => void): Promise<ModelTurn> {
    const f = this.cfg.fetch ?? fetch;
    const res = await f(`${this.cfg.baseUrl.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(await this.cfg.headers()) },
      body: JSON.stringify(body),
      signal,
    });
    const requestId = res.headers.get('x-request-id') ?? undefined;
    if (!res.ok || !res.body) throw await httpError(res, requestId);

    let text = '';
    const items: Json[] = [];
    let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let stop: ModelTurn['stopReason'] = 'end';
    let completed = false;
    let webSearches = 0;

    for await (const msg of readSse(res.body, signal)) {
      if (msg.data === '[DONE]') break;
      let ev: Json;
      try {
        ev = JSON.parse(msg.data);
      } catch {
        continue;
      }
      const type = (ev.type as string) ?? msg.event;
      switch (type) {
        case 'response.output_text.delta':
          text += ev.delta as string;
          onEvent({ type: 'text', delta: ev.delta as string });
          break;
        case 'response.reasoning_summary_text.delta':
          onEvent({ type: 'reasoning', delta: ev.delta as string });
          break;
        case 'response.output_item.added': {
          const item = ev.item as Json;
          if (item?.type === 'function_call') onEvent({ type: 'tool_call_started', name: String(item.name) });
          if (item?.type === 'web_search_call') {
            webSearches++;
            onEvent({ type: 'web_search' });
          }
          break;
        }
        case 'response.output_item.done':
          items.push(ev.item as Json);
          break;
        case 'response.completed':
        case 'response.incomplete': {
          completed = true;
          const r = ev.response as Json;
          if (Array.isArray(r?.output) && (r.output as Json[]).length) {
            items.length = 0;
            items.push(...(r.output as Json[]));
          }
          const u = (r?.usage ?? {}) as Json;
          usage = {
            inputTokens: Number(u.input_tokens ?? 0),
            outputTokens: Number(u.output_tokens ?? 0),
            cachedTokens: Number((u.input_tokens_details as Json | undefined)?.cached_tokens ?? 0),
          };
          if (type === 'response.incomplete') stop = 'max_tokens';
          break;
        }
        case 'response.failed': {
          const err = ((ev.response as Json)?.error ?? {}) as Json;
          throw classify(String(err.message ?? 'The model request failed.'), undefined, err.code as string | undefined, requestId);
        }
        case 'error': {
          const err = ((ev.error as Json) ?? ev) as Json;
          throw classify(String(err.message ?? 'The model stream reported an error.'), undefined, (err.code ?? err.type) as string | undefined, requestId);
        }
      }
    }
    if (!completed) throw new ModelError('The model stream ended before completing.', undefined, 'stream_interrupted', true, requestId);

    // Final text and tool calls come from the completed output items.
    const toolCalls: ModelToolCall[] = [];
    let finalText = '';
    for (const item of items) {
      if (item.type === 'message') {
        for (const part of (item.content as Json[]) ?? []) {
          if (part.type === 'output_text') finalText += String(part.text ?? '');
          if (part.type === 'refusal') {
            finalText += String(part.refusal ?? '');
            stop = 'refusal';
          }
        }
      } else if (item.type === 'function_call') {
        const ns = (item.namespace as string | undefined) ?? undefined;
        const { namespace, name } = this.cfg.namespaces && ns ? { namespace: ResponsesClient.ownNamespace(ns), name: String(item.name) } : unflatName(String(item.name));
        const parsed = parseArgs(item.arguments as string);
        // A call from an incomplete response (or one not marked completed) is recorded, never run.
        const unfinished = stop === 'max_tokens' || (item.status !== undefined && item.status !== 'completed');
        toolCalls.push({ callId: String(item.call_id), namespace, name, args: parsed.args, argsError: unfinished ? 'Not run: the reply was cut off before this call was complete.' : parsed.error });
      }
    }
    if (toolCalls.length && stop === 'end') stop = 'tool_calls';
    return {
      text: finalText || text,
      toolCalls,
      raw: { format: 'responses', items },
      usage,
      stopReason: stop,
      webSearches,
    };
  }
}

const NS_PREFIX = 'wren_';

const NAMESPACE_HINTS: Record<string, string> = {
  computer: "Shell and files on the agent's computer.",
  browser: 'Control a real web browser.',
  web: 'Fetch web pages as text.',
  github: 'GitHub REST API.',
  memory: 'Long-term memory about the user.',
  task: 'Plan, ask the user, notify the user.',
  screen: "Capture the user's screen.",
};

async function httpError(res: Response, requestId?: string): Promise<ModelError> {
  let message = `HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const raw = await res.text();
    try {
      const j = JSON.parse(raw) as Json;
      const err = (j.error ?? j) as Json;
      message = String(err.message ?? j.detail ?? raw).slice(0, 600);
      code = (err.code ?? err.type) as string | undefined;
    } catch {
      message = raw.slice(0, 600) || message;
    }
  } catch {
    /* ignore */
  }
  return classify(message, res.status, code, requestId);
}

function classify(message: string, status: number | undefined, code: string | undefined, requestId?: string): ModelError {
  const retryable =
    status === 429 || (status !== undefined && status >= 500) || code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable' || code === 'server_error' || code === 'rate_limit_exceeded';
  const limit = code === 'subscription_sharing_usage_limit_exceeded' || code === 'insufficient_quota';
  return new ModelError(clipMiddle(message, 800), status, code, retryable && !limit, requestId);
}
