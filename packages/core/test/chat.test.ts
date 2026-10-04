import { describe, expect, it } from 'vitest';
import { ChatClient } from '../src/models/chat';
import type { SessionEvent } from '../src/types';

const sse = (lines: string[]) =>
  (async () =>
    new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode(lines.map((l) => `data: ${l}\n\n`).join(''))), c.close()) }), { status: 200 })) as unknown as typeof fetch;
const req = { model: 'm', instructions: 'x', events: [{ id: 'e1', seq: 1, runId: 'r', type: 'message', status: 'done', data: { role: 'user', text: 'hi' } } as SessionEvent], tools: [{ namespace: 'computer', name: 'shell', description: '', parameters: {} }], hosted: [] };
const call = JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'computer__shell', arguments: '{"command":"ls"}' } }] } }] });

describe('ChatClient stream endings', () => {
  it('rejects a stream that stops without finishing', async () => {
    const client = new ChatClient({ origin: 'local', baseUrl: 'http://x/v1', fetch: sse([call]) });
    await expect(client.stream(req, () => {})).rejects.toMatchObject({ code: 'stream_interrupted' });
  });
  it('surfaces an error event instead of ignoring it', async () => {
    const client = new ChatClient({ origin: 'local', baseUrl: 'http://x/v1', fetch: sse([call, JSON.stringify({ error: { message: 'out of memory' } })]) });
    await expect(client.stream(req, () => {})).rejects.toThrow(/out of memory/);
  });
  it('runs calls from a properly finished stream', async () => {
    const client = new ChatClient({ origin: 'local', baseUrl: 'http://x/v1', fetch: sse([call, JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }), '[DONE]']) });
    const turn = await client.stream(req, () => {});
    expect(turn.toolCalls[0]).toMatchObject({ name: 'shell', args: { command: 'ls' } });
    expect(turn.toolCalls[0].argsError).toBeUndefined();
  });
});
