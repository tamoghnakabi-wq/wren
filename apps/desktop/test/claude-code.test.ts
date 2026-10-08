import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Claude Code 2.1.2xx has no TodoWrite: its to-do list is TaskCreate/TaskUpdate. The engine runs here against a
// fake `claude -p --output-format stream-json` that replays what the real CLI printed (2.1.294).

const CLI = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const use = (id, name, input) => out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text, extra) => out({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, ...(extra ? { tool_use_result: extra } : {}) });
const say = (text) => {
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
};
rl.once('line', (line) => {
  if (JSON.parse(line).message.content === 'delegate') return delegate();
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  say('Planning.');
  use('c1', 'TaskCreate', { subject: 'Count lines', description: 'Read notes.txt' });
  result('c1', 'Task #1 created successfully: Count lines', { task: { id: '1', subject: 'Count lines' } });
  use('c2', 'TaskCreate', { subject: 'Report', description: 'Say the count' });
  result('c2', 'Task #2 created successfully: Report');
  use('c3', 'TaskUpdate', { taskId: '1', status: 'in_progress' });
  result('c3', 'Updated task #1 status');
  use('c4', 'Read', { file_path: 'notes.txt' });
  result('c4', 'one line');
  use('c5', 'TaskUpdate', { taskId: '7', status: 'completed' }); // made in an earlier turn
  result('c5', 'Updated task #7 status');
  use('c6', 'TaskUpdate', { taskId: '1', status: 'completed' });
  result('c6', 'Updated task #1 status');
  say('It has one line.');
  out({ type: 'result', subtype: 'success', is_error: false, result: 'It has one line.', num_turns: 3 });
});
// A background sub-agent (2.1.294): the turn ends with a result, the sub-agent's Write (which needed
// approval, so Wren has a step for it) reports back, then a second turn and result follow.
function delegate() {
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  use('a1', 'Agent', { description: 'Write sub.txt' });
  result('a1', 'Async agent launched successfully.');
  say('Started the sub-agent.');
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Started the sub-agent.', num_turns: 2, usage: { input_tokens: 10, output_tokens: 5 } });
  out({ type: 'assistant', parent_tool_use_id: 'a1', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'sub.txt' } }] } });
  out({ type: 'user', parent_tool_use_id: 'a1', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'File created' }] } });
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  say('Done.');
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', num_turns: 1, usage: { input_tokens: 7, output_tokens: 3 } });
}
rl.on('close', () => process.exit(0));
`;
const dir = mkdtempSync(join(tmpdir(), 'wren-claude-test-'));
const cliPath = join(dir, 'fake-claude.cjs');
writeFileSync(cliPath, CLI);

const h = vi.hoisted(() => ({ log: [] as string[], plans: [] as unknown[], prompted: [] as string[] }));
vi.mock('../src/engines/common', () => {
  class TimelineWriter {
    text = '';
    tools = new Map<string, unknown>();
    constructor(..._args: unknown[]) {
      for (const id of h.prompted) this.tools.set(id, {}); // steps made by permission prompts
    }
    async textDelta(d: string) {
      this.text += d;
    }
    async endMessage(final?: string) {
      const t = final ?? this.text;
      if (t) h.log.push(`message:${t}`);
      this.text = '';
    }
    async toolStart(callId: string) {
      await this.endMessage();
      this.tools.set(callId, {});
      h.log.push(`start:${callId}`);
      return callId;
    }
    async toolEnd(callId: string, output: string) {
      if (this.tools.has(callId)) h.log.push(`end:${callId}:${output}`); // like the real one: only steps it started
    }
    get currentText() {
      return this.text;
    }
  }
  return {
    TimelineWriter,
    findCli: () => '/fake/claude',
    claudeSupportsRestricted: () => true,
    decide: async () => ({ allow: true }),
    startApprovalBridge: async () => ({ url: 'http://127.0.0.1:9', token: 't', close() {} }),
    spawnClaude: async () => spawn(process.execPath, [cliPath], { stdio: ['pipe', 'pipe', 'pipe'] }),
    stopEngine: async (p: { kill: () => void }) => p.kill(),
  };
});
const { runClaudeCode } = await import('../src/engines/claude-code');

beforeEach(() => {
  h.log = [];
  h.plans = [];
  h.prompted = [];
});

const engineRun = (prompt: string, extra: Record<string, unknown> = {}) => ({
  runId: 'r1',
  store: { usageSource: '', append: async (type: string, data: unknown) => (type === 'plan' && h.plans.push(data), { id: 'e' }), update: async () => {}, recordUsage: async (u: unknown) => void h.log.push(`usage:${JSON.stringify(u)}`) } as never,
  agentName: 'coder',
  autonomy: 'balanced' as const,
  instructions: '',
  model: 'default',
  prompt,
  cwd: dir,
  folders: [dir],
  allow: { shell: true, browser: true, screen: true },
  signal: new AbortController().signal,
  saveResumeId: async (id: string) => void h.log.push(`session:${id}`),
  ...extra,
});

describe('Claude Code background sub-agents', () => {
  it("end the sub-agent's approved step, keep one session record, and count both turns", async () => {
    h.prompted = ['w1'];
    const outcome = await runClaudeCode(engineRun('delegate'), () => true, '/dev/null');
    expect(outcome).toMatchObject({ kind: 'completed', result: 'Done.', steps: 3 });
    expect(h.log).toEqual([
      'session:sess-1',
      'start:a1',
      'end:a1:Async agent launched successfully.',
      'message:Started the sub-agent.',
      'end:w1:File created',
      'message:Done.',
      `usage:${JSON.stringify({ inputTokens: 17, outputTokens: 8, cachedTokens: 0 })}`,
    ]);
  });
});

describe('Claude Code to-do list', () => {
  it('becomes the plan (not steps), and continues the list an earlier turn left', async () => {
    const run = {
      runId: 'r1',
      store: { usageSource: '', append: async (type: string, data: unknown) => (type === 'plan' && h.plans.push(data), { id: 'e' }), update: async () => {}, recordUsage: async () => {} } as never,
      agentName: 'coder',
      autonomy: 'balanced' as const,
      instructions: '',
      model: 'default',
      prompt: 'count',
      cwd: dir,
      folders: [dir],
      allow: { shell: true, browser: true, screen: true },
      plan: [{ id: '7', text: 'Earlier task', status: 'in_progress' as const }],
      signal: new AbortController().signal,
      saveResumeId: async () => {},
    };
    const outcome = await runClaudeCode(run, () => true, '/dev/null');
    expect(outcome).toMatchObject({ kind: 'completed', result: 'It has one line.' });
    // Only the real tool is a step; text on either side of the list's updates stays separate messages.
    expect(h.log).toEqual(['message:Planning.', 'start:c4', 'end:c4:one line', 'message:It has one line.']);
    expect(h.plans.at(-1)).toEqual({
      items: [
        { id: '7', text: 'Earlier task', status: 'done' },
        { id: '1', text: 'Count lines', status: 'done' },
        { id: '2', text: 'Report', status: 'pending' },
      ],
    });
    expect(h.plans[0]).toEqual({ items: [{ id: '7', text: 'Earlier task', status: 'in_progress' }, { id: '1', text: 'Count lines', status: 'pending' }] });
  });
});
