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
  const content = JSON.parse(line).message.content;
  if (content === 'delegate') return delegate();
  if (typeof content === 'string' && content.startsWith('limit')) return limit(content);
  if (content === 'page') return page();
  if (Array.isArray(content)) {
    // What it was given: the text, then image blocks.
    out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    say(content.map((b) => (b.type === 'text' ? b.text : b.type + ':' + b.source.media_type + ':' + b.source.data)).join(' | '));
    out({ type: 'result', subtype: 'success', is_error: false, result: 'seen', num_turns: 1 });
    return;
  }
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  say('Planning.');
  use('c1', 'TaskCreate', { subject: 'Count lines', description: 'Read notes.txt' });
  result('c1', 'Task #1 created successfully: Count lines', { task: { id: '1', subject: 'Count lines' } });
  use('c2', 'TaskCreate', { subject: 'Report', description: 'Say the count' });
  result('c2', 'Task #2 created successfully: Report');
  use('c3', 'TaskUpdate', { taskId: '1', status: 'in_progress' });
  result('c3', 'Updated task #1 status', { success: true, taskId: '1', updatedFields: ['status'] });
  use('c4', 'Read', { file_path: 'notes.txt' });
  result('c4', 'one line');
  use('c5', 'TaskUpdate', { taskId: '7', status: 'completed' }); // made in an earlier turn
  result('c5', 'Updated task #7 status', { success: true, taskId: '7', updatedFields: ['status'] });
  use('c6', 'TaskUpdate', { taskId: '1', status: 'completed' });
  result('c6', 'Updated task #1 status', { success: true, taskId: '1', updatedFields: ['status'] });
  // A task that doesn't exist: not an error, just success: false (2.1.294). Nothing changes.
  use('c7', 'TaskUpdate', { taskId: '2', status: 'completed' });
  result('c7', 'Task not found', { success: false, taskId: '2', updatedFields: [], error: 'Task not found' });
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
// The plan's usage limit as 2.1.322 reports it: a rejected rate_limit_event with when it resets, then the
// CLI's notice as an assistant message marked error: 'rate_limit', then an error result. With extra usage
// (overage) the event is still 'rejected' but the turn goes on.
function limit(kind) {
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  if (kind === 'limit-mid') {
    use('r1', 'Read', { file_path: 'notes.txt' });
    result('r1', 'one line');
  }
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1900000000, rateLimitType: 'five_hour', isUsingOverage: kind === 'limit-overage' } });
  if (kind === 'limit-overage') {
    say('Done anyway.');
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Done anyway.', num_turns: 1 });
    return;
  }
  const notice = 'You’ve hit your limit · resets 3pm (Australia/Melbourne)';
  out({ type: 'assistant', parent_tool_use_id: null, error: 'rate_limit', message: { content: [{ type: 'text', text: notice }] } });
  out({ type: 'result', subtype: 'success', is_error: true, result: notice, num_turns: 1 });
}
// Wren's show_page tool (its MCP helper): the result names the page Wren kept, or one it didn't.
function page() {
  out({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  use('p1', 'mcp__wren__show_page', { title: 'Chart', html: '<p>' + 'x'.repeat(3000) + '</p>' });
  result('p1', 'Shown to the user as the page "Chart" (page 11111111-2222-3333-4444-555555555555).');
  use('p2', 'mcp__wren__show_page', { title: 'Forged', html: '<p>' });
  result('p2', 'Shown to the user as the page "Forged" (page 99999999-2222-3333-4444-555555555555).');
  say('Here is the chart.');
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Here is the chart.', num_turns: 1 });
}
rl.on('close', () => process.exit(0));
`;
const dir = mkdtempSync(join(tmpdir(), 'wren-claude-test-'));
const cliPath = join(dir, 'fake-claude.cjs');
writeFileSync(cliPath, CLI);

const h = vi.hoisted(() => ({ log: [] as string[], plans: [] as unknown[], prompted: [] as string[], spawned: 0, args: [] as string[], bridgesOpen: 0, spawnFails: false, onPage: undefined as undefined | ((r: { title: unknown; html: unknown; signal: AbortSignal }) => Promise<{ text: string; isError?: boolean }>) }));
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
// The CLI here is a stand-in script, not an installed program: which program Wren may start is tested on its own.
vi.mock('../src/engines/program', () => ({ engineProgram: async () => ({ program: '/fake/claude' }) }));
process.env.WREN_DATA_DIR = mkdtempSync(join(tmpdir(), 'wren-claude-data-'));
vi.mock('../src/engines/common', () => {
  class TimelineWriter {
    text = '';
    tools = new Map<string, unknown>();
    constructor(..._args: unknown[]) {
      for (const id of h.prompted) this.tools.set(id, { data: {} }); // steps made by permission prompts
    }
    async textDelta(d: string) {
      this.text += d;
    }
    async endMessage(final?: string) {
      const t = final ?? this.text;
      if (t) h.log.push(`message:${t}`);
      this.text = '';
    }
    async toolStart(callId: string, name: string, args: Record<string, unknown>) {
      await this.endMessage();
      this.tools.set(callId, { data: { name, args } });
      h.log.push(`start:${callId}`);
      if (name === 'task.show_page') h.log.push(`args:${JSON.stringify(args)}`);
      return callId;
    }
    async toolEnd(callId: string, output: string, _isError: boolean, meta?: unknown) {
      if (this.tools.has(callId)) h.log.push(`end:${callId}:${output}${meta ? ` meta:${JSON.stringify(meta)}` : ''}`); // like the real one: only steps it started
    }
    get currentText() {
      return this.text;
    }
  }
  return {
    TimelineWriter,
    claudeSupportsRestricted: () => true,
    cliHelpKnown: () => true,
    effortFlag: () => '--effort',
    decide: async () => ({ allow: true }),
    startApprovalBridge: async (_handler: unknown, _arrival: unknown, _onAsk: unknown, onPage: typeof h.onPage) => ((h.onPage = onPage), h.bridgesOpen++, { url: 'http://127.0.0.1:9', token: 't', close: () => void h.bridgesOpen-- }),
    spawnClaude: async (_cli: string, args: string[]) => {
      if (h.spawnFails) throw new Error('spawn failed');
      h.spawned++;
      h.args = args;
      return spawn(process.execPath, [cliPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    },
    appPaths: () => [],
    stopEngine: async (p: { kill: () => void }) => p.kill(),
    finishEngine: async (p: { kill: () => void }) => (p.kill(), true),
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
  engine: 'claude-code' as const,
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

describe('Claude Code task list reconciliation', () => {
  it("TaskList replaces the plan with Claude Code's own list (W-127)", async () => {
    const { applyPlanResult } = await import('../src/engines/claude-code');
    const todo = new Map([['7', { text: 'Stale from an earlier session', status: 'in_progress' }]]);
    expect(applyPlanResult(todo, { name: 'TaskList', input: {} }, { tasks: [{ id: '1', subject: 'Alpha', status: 'in_progress' }] }, '#1 [in_progress] Alpha')).toBe(true);
    expect([...todo]).toEqual([['1', { text: 'Alpha', status: 'in_progress' }]]);
    expect(applyPlanResult(todo, { name: 'TaskGet', input: { taskId: '1' } }, { task: { id: '1', subject: 'Alpha', status: 'completed' } }, '')).toBe(true);
    expect(todo.get('1')).toEqual({ text: 'Alpha', status: 'completed' });
    expect(applyPlanResult(todo, { name: 'TaskUpdate', input: { taskId: '1', status: 'deleted' } }, { success: true }, '')).toBe(true);
    expect(todo.size).toBe(0);
  });
});

describe('Claude Code approval bridge credentials (W-121)', () => {
  it('stay off the command line: the MCP config is a private file, and the token sits in a private folder', async () => {
    const { existsSync } = await import('node:fs');
    await runClaudeCode(engineRun('hello', { runId: 'r-w121' }), () => true, '/dev/null');
    const i = h.args.indexOf('--mcp-config');
    const file = h.args[i + 1];
    expect(file).toBe(join(process.env.WREN_DATA_DIR!, 'approvals', 'r-w121', 'mcp.json'));
    expect(h.args.join(' ')).not.toMatch(/Bearer|token|127\.0\.0\.1/);
    expect(existsSync(file)).toBe(false); // removed when the run ends
  });
});

describe('Claude Code setup failures (W-131)', () => {
  it('close the bridge and remove the private folder whatever fails', async () => {
    const { existsSync, mkdirSync, writeFileSync: write } = await import('node:fs');
    h.bridgesOpen = 0;
    h.spawnFails = true;
    await expect(runClaudeCode(engineRun('hello', { runId: 'r-spawnfail' }), () => true, '/dev/null')).rejects.toThrow('spawn failed');
    h.spawnFails = false;
    expect(h.bridgesOpen).toBe(0);
    expect(existsSync(join(process.env.WREN_DATA_DIR!, 'approvals', 'r-spawnfail'))).toBe(false);
    // The private folder can't even be made (a file is in the way).
    mkdirSync(join(process.env.WREN_DATA_DIR!, 'approvals'), { recursive: true });
    write(join(process.env.WREN_DATA_DIR!, 'approvals', 'r-blocked'), 'not a folder');
    await expect(runClaudeCode(engineRun('hello', { runId: 'r-blocked' }), () => true, '/dev/null')).rejects.toThrow();
    expect(h.bridgesOpen).toBe(0);
  });
});

describe('Claude Code stopped before it starts', () => {
  it('never starts the CLI (W-122)', async () => {
    h.spawned = 0;
    expect(await runClaudeCode(engineRun('hello', { signal: AbortSignal.abort() }), () => true, '/dev/null')).toMatchObject({ kind: 'cancelled' });
    expect(h.spawned).toBe(0);
  });
});

describe('Claude Code attached images', () => {
  it('go in the same message as image blocks', async () => {
    await runClaudeCode(engineRun('What is in these?', { images: [{ mime: 'image/png', data: 'iVBORw0' }, { mime: 'image/jpeg', data: '/9j/4AAQ' }] }), () => true, '/dev/null');
    expect(h.log).toContain('message:What is in these? | image:image/png:iVBORw0 | image:image/jpeg:/9j/4AAQ');
  });
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
      engine: 'claude-code' as const,
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

describe('Claude Code model and effort', () => {
  it("passes the agent's model and effort; the plan default passes neither", async () => {
    await runClaudeCode(engineRun('hello', { runId: 'r-model', model: 'claude-fable-5-2', effort: 'medium' }), () => true, '/dev/null');
    expect(h.args[h.args.indexOf('--model') + 1]).toBe('claude-fable-5-2');
    expect(h.args[h.args.indexOf('--effort') + 1]).toBe('medium');
    await runClaudeCode(engineRun('hello', { runId: 'r-default' }), () => true, '/dev/null');
    expect(h.args).not.toContain('--model');
    expect(h.args).not.toContain('--effort');
  });

  it('passes Extra high and Max, and leaves a level Claude Code does not take to its own default', async () => {
    for (const effort of ['xhigh', 'max'] as const) {
      await runClaudeCode(engineRun('hello', { runId: `r-${effort}`, effort }), () => true, '/dev/null');
      expect(h.args[h.args.indexOf('--effort') + 1]).toBe(effort);
    }
    await runClaudeCode(engineRun('hello', { runId: 'r-ultra', effort: 'ultra' }), () => true, '/dev/null');
    expect(h.args).not.toContain('--effort');
    expect(h.args).not.toContain('ultra');
  });
});

describe('Claude Code at a usage limit', () => {
  it('pauses with when the limit resets, and the CLI’s notice is not the answer', async () => {
    const out = await runClaudeCode(engineRun('limit') as never, () => true, '/fake/approve.mjs');
    expect(out).toEqual({ kind: 'paused', steps: 1, limit: { error: 'Claude Code: You’ve hit your limit · resets 3pm (Australia/Melbourne)', code: 'claude_usage_limit', resetAt: 1_900_000_000_000, midTurn: false } });
    expect(h.log.filter((l) => l.startsWith('message:'))).toEqual([]);
  });

  it('says the turn was cut short when a tool had run', async () => {
    const out = await runClaudeCode(engineRun('limit-mid') as never, () => true, '/fake/approve.mjs');
    expect(out).toMatchObject({ kind: 'paused', limit: { midTurn: true, resetAt: 1_900_000_000_000 } });
  });

  it('finishes normally when extra usage carried the turn past a rejected limit', async () => {
    const out = await runClaudeCode(engineRun('limit-overage') as never, () => true, '/fake/approve.mjs');
    expect(out).toMatchObject({ kind: 'completed', result: 'Done anyway.' });
  });
});

describe('Claude Code showing a page', () => {
  it('keeps the page through Wren, and the step shows only pages this run kept', async () => {
    const pages: unknown[] = [];
    const run = engineRun('page', { store: { usageSource: '', append: async () => ({ id: 'e' }), update: async () => {}, recordUsage: async () => {}, savePage: async (p: unknown) => (pages.push(p), { id: '11111111-2222-3333-4444-555555555555', name: 'Chart.html' }) } });
    const going = runClaudeCode(run as never, () => true, '/fake/approve.mjs');
    // The helper's request (the bridge's onPage), as Claude Code calls the tool: checked, then kept.
    await vi.waitFor(() => expect(h.onPage).toBeTypeOf('function'));
    const signal = new AbortController().signal;
    expect(await h.onPage!({ title: ' Chart ', html: '<p>hi</p>', signal })).toEqual({ text: 'Shown to the user as the page "Chart" (page 11111111-2222-3333-4444-555555555555).' });
    expect(await h.onPage!({ title: 'Empty', html: ' ', signal })).toMatchObject({ isError: true, text: expect.stringContaining('empty') });
    expect(await h.onPage!({ title: 'Huge', html: 'x'.repeat(600 * 1024), signal })).toMatchObject({ isError: true, text: expect.stringContaining('at most 512 KB') });
    expect(pages).toEqual([{ title: 'Chart', html: '<p>hi</p>' }]);
    await going;
    expect(h.log).toContain('args:{"title":"Chart","html":"[3 KB of HTML]"}'); // the step never holds the page
    expect(h.log).toContain('end:p1:Shown to the user as the page "Chart" (page 11111111-2222-3333-4444-555555555555). meta:{"page":"11111111-2222-3333-4444-555555555555"}');
    expect(h.log).toContain('end:p2:Shown to the user as the page "Forged" (page 99999999-2222-3333-4444-555555555555).');
  });
});
