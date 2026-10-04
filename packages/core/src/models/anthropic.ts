import Anthropic from '@anthropic-ai/sdk';
import { buildTurns, flatName, unflatName, type NeutralTurn } from '../transcript';
import type { ImageRef, ModelClient, ModelRequest, ModelStreamEvent, ModelToolCall, ModelTurn } from '../types';
import { ModelError } from '../types';

// Anthropic Messages API adapter (official SDK), used with the user's own
// Anthropic API key.
//
// History is rendered append-only: thinking blocks are replayed verbatim and
// earlier turns are never edited, because current models bind each thinking
// block to the conversation prefix that produced it. Old tool results are
// cleared server-side (context editing) instead of being trimmed here, and
// `drop_block` keeps a request working if the prefix ever does change.

export interface AnthropicConfig {
  apiKey: string;
  baseURL?: string;
  loadImage?: (ref: ImageRef) => Promise<{ mime: string; data: string } | null>;
  maxImages?: number;
}

type Block = Record<string, unknown>;
type Msg = { role: 'user' | 'assistant'; content: Block[] };

const THINKING_MODELS = /claude-(opus|sonnet)-(4-[6-9]|5)|claude-fable|claude-mythos/;
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5$|fable-5-1|sonnet-5-5)/;
const NEW_WEB_SEARCH = /claude-(opus|sonnet)-(4-[6-9]|5)|claude-fable|claude-mythos/;

export class AnthropicClient implements ModelClient {
  readonly label = 'anthropic';
  private client: Anthropic;

  constructor(private readonly cfg: AnthropicConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 1 });
  }

  private async renderMessages(turns: NeutralTurn[]): Promise<Msg[]> {
    const msgs: Msg[] = [];
    const push = (role: Msg['role'], blocks: Block[]) => {
      if (!blocks.length) return;
      const last = msgs[msgs.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else msgs.push({ role, content: blocks });
    };
    // Keep the newest images; older ones become a stable placeholder. The
    // placeholder decision is made once per image (by position from the end),
    // so it only changes the prefix when a new image pushes an old one out.
    const keep = this.cfg.maxImages ?? 20;
    const allImages: ImageRef[] = [];
    for (const t of turns) {
      if (t.kind === 'user') allImages.push(...t.images);
      else for (const c of t.calls) allImages.push(...c.images);
    }
    const keepSet = new Set(allImages.slice(Math.max(0, allImages.length - keep)));
    const imageBlock = async (ref: ImageRef): Promise<Block> => {
      const d = keepSet.has(ref) ? (ref.data ? { mime: ref.mime, data: ref.data } : await this.cfg.loadImage?.(ref)) : null;
      if (!d) return { type: 'text', text: '[image omitted]' };
      return { type: 'image', source: { type: 'base64', media_type: d.mime, data: d.data } };
    };

    for (const t of turns) {
      if (t.kind === 'user') {
        const blocks: Block[] = [];
        for (const ref of t.images) blocks.push(await imageBlock(ref));
        blocks.push({ type: 'text', text: t.text || '(empty message)' });
        push('user', blocks);
        continue;
      }
      let assistant: Block[];
      if (t.raw?.format === 'anthropic' && t.origin === 'anthropic') {
        assistant = (t.raw.items as Block[]).filter((b) => b && typeof b === 'object');
      } else {
        assistant = [];
        if (t.text) assistant.push({ type: 'text', text: t.text });
        for (const c of t.calls) assistant.push({ type: 'tool_use', id: safeId(c.callId), name: flatName(c.namespace, c.name), input: c.args });
      }
      if (!assistant.length) assistant = [{ type: 'text', text: '(no response)' }];
      push('assistant', assistant);
      if (t.calls.length) {
        const results: Block[] = [];
        for (const c of t.calls) {
          const content: Block[] = [{ type: 'text', text: c.output || '(no output)' }];
          for (const ref of c.images) content.push(await imageBlock(ref));
          results.push({ type: 'tool_result', tool_use_id: safeId(c.callId), content, ...(c.isError ? { is_error: true } : {}) });
        }
        push('user', results);
      }
    }
    // Cache the conversation prefix up to the last block.
    const last = msgs[msgs.length - 1];
    if (last) {
      const block = last.content[last.content.length - 1];
      if (block) block.cache_control = { type: 'ephemeral' };
    }
    return msgs;
  }

  async stream(req: ModelRequest, onEvent: (e: ModelStreamEvent) => void): Promise<ModelTurn> {
    const turns = buildTurns(req.events);
    const messages = await this.renderMessages(turns);
    const thinking = THINKING_MODELS.test(req.model);
    const tools: Block[] = req.tools.map((t) => ({
      name: flatName(t.namespace, t.name),
      description: t.description,
      input_schema: t.parameters,
      eager_input_streaming: true,
    }));
    if (req.hosted.some((h) => h.type === 'web_search')) {
      tools.push({ type: NEW_WEB_SEARCH.test(req.model) ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 5 });
    }
    const betas = ['context-management-2025-06-27'];
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? 32000,
      system: [{ type: 'text', text: req.instructions, cache_control: { type: 'ephemeral' } }],
      messages,
      tools,
      context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
    };
    if (thinking) {
      betas.push('thinking-binding-controls-2026-08-01');
      params.thinking = { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
      params.output_config = { effort: req.effort ?? 'high' };
    }
    if (FALLBACK_MODELS.test(req.model)) {
      betas.push('server-side-fallback-2026-07-01');
      params.fallbacks = 'default';
    }

    try {
      return await this.run(params, betas, req.signal, onEvent);
    } catch (e) {
      const err = e as ModelError;
      // A partner endpoint or older model may not know an optional beta: retry plainly once.
      if (err.status === 400 && /beta|block_binding|context_management|fallbacks|Extra inputs/i.test(err.message)) {
        delete params.context_management;
        delete params.fallbacks;
        if (params.thinking) params.thinking = { type: 'adaptive', display: 'summarized' };
        if (/bound to a different conversation|Invalid `signature`/i.test(err.message)) stripThinking(messages);
        return this.run(params, [], req.signal, onEvent);
      }
      if (err.status === 400 && /bound to a different conversation|Invalid `signature`/i.test(err.message)) {
        stripThinking(messages);
        return this.run(params, betas, req.signal, onEvent);
      }
      throw e;
    }
  }

  private async run(params: Record<string, unknown>, betas: string[], signal: AbortSignal | undefined, onEvent: (e: ModelStreamEvent) => void): Promise<ModelTurn> {
    let final: Anthropic.Beta.BetaMessage;
    try {
      const stream = this.client.beta.messages.stream({ ...(params as object), ...(betas.length ? { betas } : {}) } as Anthropic.Beta.MessageCreateParamsStreaming, { signal });
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') onEvent({ type: 'text', delta: ev.delta.text });
          else if (ev.delta.type === 'thinking_delta') onEvent({ type: 'reasoning', delta: ev.delta.thinking });
        } else if (ev.type === 'content_block_start') {
          const b = ev.content_block as { type: string; name?: string };
          if (b.type === 'tool_use') onEvent({ type: 'tool_call_started', name: b.name ?? '' });
          if (b.type === 'server_tool_use') onEvent({ type: 'web_search' });
        }
      }
      final = await stream.finalMessage();
    } catch (e) {
      throw toModelError(e);
    }

    let text = '';
    const toolCalls: ModelToolCall[] = [];
    let webSearches = 0;
    for (const b of final.content as unknown as Block[]) {
      if (b.type === 'text') text += String(b.text ?? '');
      else if (b.type === 'tool_use') {
        const { namespace, name } = unflatName(String(b.name));
        const input = b.input;
        const ok = input && typeof input === 'object' && !Array.isArray(input);
        toolCalls.push({ callId: String(b.id), namespace, name, args: ok ? (input as Record<string, unknown>) : {}, argsError: ok ? undefined : 'Tool input was not a JSON object.' });
      } else if (b.type === 'server_tool_use') webSearches++;
    }
    const sr = final.stop_reason as string | null;
    let stopReason: ModelTurn['stopReason'] = toolCalls.length ? 'tool_calls' : 'end';
    if (sr === 'refusal') stopReason = 'refusal';
    else if (sr === 'max_tokens') stopReason = 'max_tokens';
    else if (sr === 'pause_turn') stopReason = 'other';
    if (stopReason === 'refusal' || (stopReason === 'max_tokens' && toolCalls.length)) toolCalls.length = 0; // never run a cut-off call
    const u = final.usage as unknown as Record<string, number | null>;
    return {
      text,
      toolCalls,
      raw: { format: 'anthropic', items: final.content as unknown[] },
      usage: {
        inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens ?? 0,
        cachedTokens: u.cache_read_input_tokens ?? 0,
      },
      stopReason,
      webSearches,
    };
  }
}

function stripThinking(messages: Msg[]) {
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    m.content = m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
    if (!m.content.length) m.content = [{ type: 'text', text: '(no response)' }];
  }
}

function safeId(id: string): string {
  const s = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return s || 'call';
}

function toModelError(e: unknown): ModelError {
  if (e instanceof ModelError) return e;
  if (e instanceof Anthropic.APIError) {
    const status = e.status;
    const body = (e as unknown as { error?: { error?: { type?: string; message?: string } } }).error;
    const code = body?.error?.type;
    const retryable = e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || status === 529 || status === 408;
    return new ModelError(body?.error?.message ?? e.message, status, code, retryable, (e as unknown as { requestID?: string }).requestID ?? undefined);
  }
  if (e instanceof Anthropic.APIConnectionError) return new ModelError(e.message, undefined, 'connection_error', true);
  if ((e as Error)?.name === 'AbortError' || e instanceof Anthropic.APIUserAbortError) return new ModelError('Request aborted.', undefined, 'aborted', false);
  return new ModelError((e as Error)?.message ?? String(e), undefined, undefined, false);
}
