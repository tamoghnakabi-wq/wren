import { describe, expect, it } from 'vitest';
import { limitReset, ResponsesClient } from '../src/models/responses';
import type { SessionEvent } from '../src/types';

// A fake /responses endpoint: records the request body and streams back one
// completed response with the given output items.
function fakeFetch(output: unknown[]) {
  const bodies: Record<string, unknown>[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const completed = { type: 'response.completed', response: { output, usage: { input_tokens: 10, output_tokens: 5 } } };
    const sse = `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`;
    return new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(sse)), c.close()) }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
  return { f, bodies };
}

const tools = [
  { namespace: 'computer', name: 'shell', description: 'Run a command', parameters: { type: 'object', properties: {} } },
  { namespace: 'browser', name: 'navigate', description: 'Open a URL', parameters: { type: 'object', properties: {} } },
];

const ev = (seq: number, type: SessionEvent['type'], data: unknown, status = 'done'): SessionEvent =>
  ({ id: `ev${seq}`, seq, runId: 'run1', type, data, status }) as SessionEvent;

describe('ResponsesClient namespaces', () => {
  it('never sends a reserved namespace name and maps calls back', async () => {
    const { f, bodies } = fakeFetch([{ type: 'function_call', call_id: 'c2', namespace: 'wren_computer', name: 'shell', arguments: '{"cmd":"date"}' }]);
    const client = new ResponsesClient({ origin: 'chatgpt', baseUrl: 'https://example.test/v1', headers: () => ({}), namespaces: true, chatgptPlan: true, fetch: f });
    const events = [
      ev(1, 'message', { role: 'user', text: 'hi' }),
      ev(2, 'message', { role: 'assistant', text: '' }),
      ev(3, 'tool', { callId: 'c1', name: 'computer.shell', args: { cmd: 'ls' }, title: 'ls', risk: 'low', turnId: 'ev2', result: { output: 'a.txt' } }),
    ];
    const turn = await client.stream({ model: 'gpt-5.5', instructions: 'x', events, tools, hosted: [] }, () => {});

    const body = bodies[0] as { tools: { type: string; name: string }[]; input: { type: string; namespace?: string }[] };
    expect(body.tools.map((t) => t.name)).toEqual(['wren_computer', 'wren_browser']);
    const replayed = body.input.filter((i) => i.type === 'function_call');
    expect(replayed.map((i) => i.namespace)).toEqual(['wren_computer']);
    expect(turn.toolCalls).toMatchObject([{ callId: 'c2', namespace: 'computer', name: 'shell', args: { cmd: 'date' } }]);
  });

  it('keeps flat names for providers without namespaces', async () => {
    const { f, bodies } = fakeFetch([{ type: 'function_call', call_id: 'c1', name: 'computer__shell', arguments: '{}' }]);
    const client = new ResponsesClient({ origin: 'xai', baseUrl: 'https://example.test/v1', headers: () => ({}), namespaces: false, fetch: f });
    const turn = await client.stream({ model: 'm', instructions: 'x', events: [ev(1, 'message', { role: 'user', text: 'hi' })], tools, hosted: [] }, () => {});
    expect((bodies[0] as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['computer__shell', 'browser__navigate']);
    expect(turn.toolCalls[0]).toMatchObject({ namespace: 'computer', name: 'shell' });
  });
});

describe('unfinished output', () => {
  it('records calls from an incomplete response without running them', async () => {
    const bodies: unknown[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      bodies.push(init.body);
      const ev = { type: 'response.incomplete', response: { output: [{ type: 'function_call', status: 'incomplete', call_id: 'c1', namespace: 'wren_computer', name: 'shell', arguments: '{"command":"rm -rf bu' }], usage: {} } };
      const sse = `data: ${JSON.stringify(ev)}\n\n`;
      return new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(sse)), c.close()) }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ResponsesClient({ origin: 'openai', baseUrl: 'https://example.test/v1', headers: () => ({}), namespaces: true, fetch: f });
    const turn = await client.stream({ model: 'm', instructions: 'x', events: [ev(1, 'message', { role: 'user', text: 'hi' })], tools, hosted: [] }, () => {});
    expect(turn.stopReason).toBe('max_tokens');
    expect(turn.toolCalls[0].argsError).toMatch(/Not run/);
  });
});


describe('usage limit resets', () => {
  const now = 1_800_000_000_000;
  it('reads when a plan limit resets, however the provider says it', () => {
    expect(limitReset({ error: { code: 'usage_limit_reached', resets_at: 1_800_003_600 } }, null, now)).toBe(1_800_003_600_000);
    expect(limitReset({ error: { resets_at: 1_800_003_600_000 } }, null, now)).toBe(1_800_003_600_000);
    expect(limitReset({ error: { resets_in_seconds: 90 } }, null, now)).toBe(now + 90_000);
    expect(limitReset({ resets_in_seconds: '30' }, null, now)).toBe(now + 30_000);
    expect(limitReset(undefined, '120', now)).toBe(now + 120_000);
    expect(limitReset(undefined, 'Wed, 21 Oct 2026 07:28:00 GMT', now)).toBe(Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'));
    expect(limitReset({ error: { message: 'no time' } }, null, now)).toBeUndefined();
    expect(limitReset(undefined, 'soon', now)).toBeUndefined();
  });
});
