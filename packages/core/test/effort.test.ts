import { describe, expect, it } from 'vitest';
import { AnthropicClient } from '../src/models/anthropic';
import { listModels } from '../src/models/index';
import { effortLevels, type SessionEvent } from '../src/types';

// Each model lists the effort levels it takes; the picker offers those and the clients send the one chosen.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('effort levels', () => {
  it('keeps only the levels Wren knows, in its own order', () => {
    expect(effortLevels(['max', 'low', 'turbo', 'xhigh', 7])).toEqual(['low', 'xhigh', 'max']);
    expect(effortLevels([{ effort: 'ultra', description: '…' }, { effort: 'medium' }, { value: 'high' }])).toEqual(['medium', 'high', 'ultra']);
    expect(effortLevels(undefined)).toBeUndefined();
    expect(effortLevels([])).toEqual([]);
  });

  it("reads each Anthropic model's levels from the Models API", async () => {
    const level = (on: boolean) => ({ supported: on });
    const f = (async () =>
      json({
        data: [
          { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', capabilities: { effort: { supported: true, low: level(true), medium: level(true), high: level(true), xhigh: level(true), max: level(true) } } },
          { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', capabilities: { effort: { supported: true, low: level(true), medium: level(true), high: level(true), xhigh: level(false), max: level(true) } } },
          { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5', capabilities: { effort: { supported: false } } },
          { id: 'claude-old', display_name: 'Older listing' },
        ],
      })) as unknown as typeof fetch;
    expect(await listModels('anthropic', 'key', f)).toEqual([
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', efforts: [] },
      { id: 'claude-old', name: 'Older listing' },
    ]);
  });

  it("reads the ChatGPT catalog's reasoning levels", async () => {
    const f = (async () =>
      json({
        models: [
          { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6 Terra', visibility: 'list', default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({ effort, description: '' })) },
          { slug: 'hidden', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
          { slug: 'gpt-plain', display_name: 'Plain' },
        ],
      })) as unknown as typeof fetch;
    expect(await listModels('chatgpt', 'token', f)).toEqual([
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-plain', name: 'Plain' },
    ]);
  });
});

// A fake Messages endpoint: records each request body; answers with an error for the first `errors` requests.
function fakeAnthropic(errors: string[] = []) {
  const bodies: Record<string, unknown>[] = [];
  const betas: string[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    betas.push(new Headers(init.headers).get('anthropic-beta') ?? '');
    const err = errors.shift();
    if (err) return json({ type: 'error', error: { type: 'invalid_request_error', message: err } }, 400);
    const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } };
    const events = [
      ['message_start', { type: 'message_start', message }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    const sse = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    return new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(sse)), c.close()) }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  return { f, bodies, betas };
}

const events = [{ id: 'ev1', seq: 1, runId: 'run1', type: 'message', data: { role: 'user', text: 'hi' }, status: 'done' }] as SessionEvent[];
const ask = (client: AnthropicClient, model: string, effort?: 'low' | 'xhigh' | 'max') => client.stream({ model, instructions: 'x', events, tools: [], hosted: [], ...(effort ? { effort } : {}) }, () => {});

describe('Anthropic API effort', () => {
  it('sends the chosen level, and High when none is chosen', async () => {
    const { f, bodies } = fakeAnthropic();
    const client = new AnthropicClient({ apiKey: 'k', fetch: f });
    await ask(client, 'claude-fable-5-2', 'xhigh');
    await ask(client, 'claude-opus-5-5');
    expect(bodies.map((b) => b.output_config)).toEqual([{ effort: 'xhigh' }, { effort: 'high' }]);
  });

  it("sends a chosen level to a model Wren doesn't ask to think (Haiku 5.5), and none otherwise", async () => {
    const { f, bodies } = fakeAnthropic();
    const client = new AnthropicClient({ apiKey: 'k', fetch: f });
    await ask(client, 'claude-haiku-5-5', 'max');
    await ask(client, 'claude-haiku-5-5');
    expect(bodies.map((b) => b.output_config)).toEqual([{ effort: 'max' }, undefined]);
  });

  it("falls back to the model's own default when it doesn't take the level", async () => {
    const { f, bodies } = fakeAnthropic(["output_config.effort: 'xhigh' is not supported for this model."]);
    const turn = await ask(new AnthropicClient({ apiKey: 'k', fetch: f }), 'claude-opus-4-6', 'xhigh');
    expect(turn.text).toBe('done');
    expect(bodies).toHaveLength(2);
    expect(bodies[1].output_config).toBeUndefined();
    expect(bodies[1].thinking).toEqual(bodies[0].thinking);
  });
});

describe('Anthropic API refusal fallback', () => {
  it("asks Anthropic to re-run a declined request on its recommended fallback, for the models that have one", async () => {
    const { f, bodies, betas } = fakeAnthropic();
    const client = new AnthropicClient({ apiKey: 'k', fetch: f });
    const models = ['claude-fable-5-2', 'claude-mythos-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-8'];
    for (const m of models) await ask(client, m);
    expect(bodies.map((b) => b.fallbacks)).toEqual(['default', 'default', 'default', 'default', 'default', 'default', undefined, undefined]);
    expect(betas.map((b) => b.includes('server-side-fallback-2026-07-01'))).toEqual([true, true, true, true, true, true, false, false]);
  });
});
