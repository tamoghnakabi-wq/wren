import { buildTurns, flatName, limitImages, parseArgs, trimOutputs, unflatName } from '../transcript';
import type { ImageRef, ModelClient, ModelRequest, ModelStreamEvent, ModelToolCall, ModelTurn } from '../types';
import { ModelError } from '../types';
import { readSse } from './sse';

// OpenAI-compatible Chat Completions adapter for local model servers on the
// desktop (LM Studio, Ollama, llama.cpp, vLLM...).

export interface ChatConfig {
  origin: string;
  baseUrl: string;
  headers?: () => Promise<Record<string, string>> | Record<string, string>;
  loadImage?: (ref: ImageRef) => Promise<{ mime: string; data: string } | null>;
  vision?: boolean;
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

export class ChatClient implements ModelClient {
  constructor(private readonly cfg: ChatConfig) {}
  get label() {
    return this.cfg.origin;
  }

  async stream(req: ModelRequest, onEvent: (e: ModelStreamEvent) => void): Promise<ModelTurn> {
    const turns = buildTurns(req.events);
    limitImages(turns, this.cfg.vision ? 2 : 0);
    trimOutputs(turns, { recentFull: 8, recentChars: 12000, oldChars: 1500 });
    const img = async (ref: ImageRef) => (ref.data ? { mime: ref.mime, data: ref.data } : (await this.cfg.loadImage?.(ref)) ?? null);

    const messages: Json[] = [{ role: 'system', content: req.instructions }];
    for (const t of turns) {
      if (t.kind === 'user') {
        if (t.images.length && this.cfg.vision) {
          const content: Json[] = [{ type: 'text', text: t.text }];
          for (const r of t.images) {
            const d = await img(r);
            if (d) content.push({ type: 'image_url', image_url: { url: `data:${d.mime};base64,${d.data}` } });
          }
          messages.push({ role: 'user', content });
        } else messages.push({ role: 'user', content: t.text || '(empty message)' });
        continue;
      }
      messages.push({
        role: 'assistant',
        content: t.text || null,
        ...(t.calls.length
          ? { tool_calls: t.calls.map((c) => ({ id: c.callId, type: 'function', function: { name: flatName(c.namespace, c.name), arguments: JSON.stringify(c.args) } })) }
          : {}),
      });
      const imgs: Json[] = [];
      for (const c of t.calls) {
        messages.push({ role: 'tool', tool_call_id: c.callId, content: (c.isError ? 'ERROR: ' : '') + c.output });
        for (const r of c.images) {
          const d = await img(r);
          if (d) imgs.push({ type: 'image_url', image_url: { url: `data:${d.mime};base64,${d.data}` } });
        }
      }
      if (imgs.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'Image output from the tool calls above:' }, ...imgs] });
    }

    const body: Json = {
      model: req.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(req.tools.length
        ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: flatName(t.namespace, t.name), description: t.description, parameters: t.parameters } })), tool_choice: 'auto' }
        : {}),
    };
    const f = this.cfg.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...((await this.cfg.headers?.()) ?? {}) },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      throw new ModelError(`Could not reach the local model server at ${this.cfg.baseUrl}: ${(e as Error).message}`, undefined, 'connection_error', true);
    }
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      throw new ModelError(`Local model server error ${res.status}: ${t.slice(0, 400)}`, res.status, undefined, res.status >= 500);
    }

    let text = '';
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let finish = '';
    for await (const m of readSse(res.body, req.signal)) {
      if (m.data === '[DONE]') break;
      let ev: Json;
      try {
        ev = JSON.parse(m.data);
      } catch {
        continue;
      }
      const choice = ((ev.choices as Json[]) ?? [])[0];
      if (ev.usage) {
        const u = ev.usage as Json;
        usage = { inputTokens: Number(u.prompt_tokens ?? 0), outputTokens: Number(u.completion_tokens ?? 0), cachedTokens: 0 };
      }
      if (!choice) continue;
      const delta = (choice.delta ?? {}) as Json;
      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        onEvent({ type: 'text', delta: delta.content });
      }
      if (typeof delta.reasoning_content === 'string') onEvent({ type: 'reasoning', delta: delta.reasoning_content });
      for (const tc of (delta.tool_calls as Json[]) ?? []) {
        const idx = Number(tc.index ?? 0);
        const fn = (tc.function ?? {}) as Json;
        const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = String(tc.id);
        if (fn.name) {
          cur.name += String(fn.name);
          onEvent({ type: 'tool_call_started', name: cur.name });
        }
        if (fn.arguments) cur.args += String(fn.arguments);
        calls.set(idx, cur);
      }
      if (choice.finish_reason) finish = String(choice.finish_reason);
    }

    const toolCalls: ModelToolCall[] = [...calls.values()].map((c, i) => {
      const { namespace, name } = unflatName(c.name);
      const p = parseArgs(c.args);
      return { callId: c.id || `call_${Date.now().toString(36)}_${i}`, namespace, name, args: p.args, argsError: p.error };
    });
    const rawItems: Json[] = [{ role: 'assistant', content: text, tool_calls: toolCalls.map((c) => ({ id: c.callId, name: flatName(c.namespace, c.name), arguments: JSON.stringify(c.args) })) }];
    return {
      text,
      toolCalls,
      raw: { format: 'chat', items: rawItems },
      usage,
      stopReason: toolCalls.length ? 'tool_calls' : finish === 'length' ? 'max_tokens' : 'end',
    };
  }
}
