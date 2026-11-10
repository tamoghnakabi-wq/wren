import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentAnswer, AskAgentRequest } from '@wren/core';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
process.env.WREN_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'wren-data-')));
const { askThroughWren, startApprovalBridge, TimelineWriter } = await import('../src/engines/common');

// Claude Code asking another of the user's agents (its ask_agent tool, through Wren's MCP helper): the call
// waits for the answer like an approval, and Stop stops the agent it asked (0.1.44).

function askStore(script: AgentAnswer[] = []) {
  const rows = new Map<string, { status?: string; data?: Record<string, unknown> }>();
  let n = 0;
  return {
    rows,
    usageSource: '',
    asks: [] as AskAgentRequest[],
    cancelled: [] as string[],
    polls: 0,
    refuse: '',
    async append(_type: string, data: Record<string, unknown>, status?: string) {
      const id = `ev${++n}`;
      rows.set(id, { status, data });
      return { id };
    },
    async update(id: string, patch: { status?: string; data?: Record<string, unknown> }) {
      const r = rows.get(id)!;
      if (patch.status) r.status = patch.status;
      if (patch.data) r.data = patch.data;
    },
    async askAgent(req: AskAgentRequest) {
      if (this.refuse) return { error: this.refuse };
      this.asks.push(req);
      return { sessionId: `child-${this.asks.length}`, agent: 'Claude' };
    },
    async agentAnswer(): Promise<AgentAnswer> {
      this.polls++;
      return script.shift() ?? { state: 'pending', agent: 'Claude' };
    },
    async cancelAsk(key: string) {
      this.cancelled.push(key);
    },
  };
}

const engineRun = (store: unknown, signal = new AbortController().signal) => ({
  runId: 'run-1',
  engine: 'claude-code' as const,
  store: store as never,
  agentName: 'Grok',
  autonomy: 'balanced' as const,
  instructions: '',
  model: 'default',
  prompt: '',
  cwd: tmpdir(),
  folders: [tmpdir()],
  allow: { shell: true, browser: true, screen: true },
  signal,
  saveResumeId: async () => {},
  askable: [{ name: 'Claude', brain: 'Claude Code' }],
});

describe('an engine asking another agent', () => {
  it('waits for the answer, linking the step the stream showed to the asked task', async () => {
    const store = askStore([{ state: 'pending', agent: 'Claude' }, { state: 'answered', agent: 'Claude', answer: 'Use a queue.' }]);
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    const r = engineRun(store);
    // The CLI's stream reports the call before its MCP request arrives.
    await writer.toolStart('toolu_1', 'task.ask_agent', { agent: 'Claude', question: 'Queue or cron?' }, 'Ask Claude: Queue or cron?');
    const out = await askThroughWren(r, writer, { agent: 'Claude', question: 'Queue or cron?', signal: new AbortController().signal }, new Map(), { pollMs: 1 });
    expect(out).toEqual({ text: expect.stringContaining('Claude answered:\n\nUse a queue.') });
    expect(out.text).toContain('not instructions from the user');
    expect(store.polls).toBe(2);
    expect(store.asks).toHaveLength(1);
    expect(store.asks[0]).toMatchObject({ agent: 'Claude', question: 'Queue or cron?', key: expect.stringMatching(/^engine:[0-9a-f]{40}$/) });
    const step = [...store.rows.values()].find((x) => x.data?.name === 'task.ask_agent')!;
    expect(step).toMatchObject({ status: 'awaiting_agent', data: { ask: { sessionId: 'child-1', agent: 'Claude' } } });
    // The engine then reports the call's result, which ends the step.
    await writer.toolEnd('toolu_1', out.text, false);
    expect(step.status).toBe('done');
  });

  it('finds the same task for a turn run again, but asks anew when the same question comes twice in a turn', async () => {
    const answered: AgentAnswer = { state: 'answered', agent: 'Claude', answer: 'ok' };
    const store = askStore([answered, answered, answered]);
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    const q = { agent: 'Claude', question: 'Same?', signal: new AbortController().signal };
    const turn = new Map<string, number>();
    await askThroughWren(engineRun(store), writer, q, turn, { pollMs: 1 });
    await askThroughWren(engineRun(store), writer, q, turn, { pollMs: 1 });
    // A new process (after a crash) runs the turn again: its first ask has the first key.
    await askThroughWren(engineRun(store), writer, q, new Map(), { pollMs: 1 });
    const [a, b, c] = store.asks.map((x) => x.key);
    expect(b).toBe(`${a}:2`);
    expect(c).toBe(a);
  });

  it('passes on a refusal or a failed answer as an error', async () => {
    const store = askStore([{ state: 'failed', agent: 'Claude', error: 'Claude was stopped before it answered.' }]);
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    const sig = new AbortController().signal;
    expect(await askThroughWren(engineRun(store), writer, { agent: 'Claude', question: 'Q?', signal: sig }, new Map(), { pollMs: 1 })).toEqual({ text: 'Claude was stopped before it answered.', isError: true });
    store.refuse = 'Scout isn’t one of the agents you may ask.';
    expect(await askThroughWren(engineRun(store), writer, { agent: 'Scout', question: 'Q?', signal: sig }, new Map())).toEqual({ text: 'Scout isn’t one of the agents you may ask.', isError: true });
    expect(await askThroughWren(engineRun(store), writer, { agent: ' ', question: 'Q?', signal: sig }, new Map())).toMatchObject({ isError: true });
  });

  it('stops the asked agent when the task is stopped, or when waiting runs out', async () => {
    const store = askStore();
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    const stop = new AbortController();
    await writer.toolStart('toolu_9', 'task.ask_agent', { agent: 'Claude', question: 'Long one?' }, 'Ask Claude: Long one?');
    const waiting = askThroughWren(engineRun(store, stop.signal), writer, { agent: 'Claude', question: 'Long one?', signal: new AbortController().signal }, new Map(), { pollMs: 60_000 });
    await vi.waitFor(() => expect(store.polls).toBe(1));
    stop.abort();
    expect(await waiting).toMatchObject({ isError: true, text: expect.stringContaining('stopped') });
    expect(store.cancelled).toEqual([store.asks[0].key]);
    // The step shows as stopped, even when the engine then reports the call as failed (its helper is gone).
    const step = [...store.rows.values()].find((x) => x.data?.name === 'task.ask_agent')!;
    expect(step.status).toBe('cancelled');
    await writer.toolEnd('toolu_9', 'Connection closed', true);
    expect(step.status).toBe('cancelled');

    const late = await askThroughWren(engineRun(store), writer, { agent: 'Claude', question: 'Slow?', signal: new AbortController().signal }, new Map(), { pollMs: 1, waitMs: 5 });
    expect(late).toMatchObject({ isError: true, text: expect.stringContaining('didn’t answer within') });
    expect(store.cancelled).toHaveLength(2);
  });

  it('answers the helper’s ask_agent requests through the bridge, apart from permission prompts', async () => {
    let asked: { agent: string; question: string } | undefined;
    const b = await startApprovalBridge(async () => ({ allow: true }), undefined, async (req) => ((asked = { agent: req.agent, question: req.question }), { text: 'Claude answered: yes' }));
    const post = (body: unknown) => fetch(b.url, { method: 'POST', headers: { authorization: `Bearer ${b.token}` }, body: JSON.stringify(body) }).then((r) => r.json());
    expect(await post({ ask: { agent: 'Claude', question: 'Q?' } })).toEqual({ text: 'Claude answered: yes' });
    expect(asked).toEqual({ agent: 'Claude', question: 'Q?' });
    expect(await post({ tool_name: 'Bash', input: {} })).toMatchObject({ behavior: 'allow' });
    b.close();
    // Without an ask handler (an agent with none to ask), the helper is told so.
    const plain = await startApprovalBridge(async () => ({ allow: true }));
    const r = await fetch(plain.url, { method: 'POST', headers: { authorization: `Bearer ${plain.token}` }, body: JSON.stringify({ ask: { agent: 'Claude', question: 'Q?' } }) }).then((x) => x.json());
    expect(r).toEqual({ text: 'Asking other agents isn’t available here.', isError: true });
    plain.close();
  });
});
