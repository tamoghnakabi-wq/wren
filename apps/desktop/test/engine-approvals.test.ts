import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
const { decide, finishEngine, TimelineWriter } = await import('../src/engines/common');

// What an engine's permission prompt leaves on the step: a denial stays "Denied" when the engine then
// reports the refused call as an error, and the step keeps its risk and approval either way.
function fakeStore(answer: 'approved' | 'denied') {
  const rows = new Map<string, { status?: string; data?: Record<string, unknown> }>();
  let n = 0;
  return {
    rows,
    usageSource: '',
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
    async createApproval() {
      return 'ap1';
    },
    async approvalState() {
      return answer;
    },
  };
}

const run = (store: unknown) => ({
  runId: 'r',
  store: store as never,
  agentName: 'a',
  autonomy: 'careful' as const,
  instructions: '',
  model: 'default',
  prompt: '',
  cwd: tmpdir(),
  folders: [tmpdir()],
  allow: { shell: true, browser: true, screen: true },
  signal: new AbortController().signal,
  saveResumeId: async () => {},
});
const call = { callId: 'toolu_1', name: 'computer.write_file', args: { path: `${tmpdir()}/a.txt` }, title: 'Write a.txt', paths: [`${tmpdir()}/a.txt`] };

describe('after an engine turn', () => {
  it('says so on the task when its processes can\'t be confirmed stopped, and keeps trying (W-126)', async () => {
    vi.useFakeTimers();
    try {
      const notes: string[] = [];
      let calls = 0;
      const stop = async () => ++calls >= 3; // confirmed on the third try
      expect(await finishEngine({} as never, { status: async (t: string) => void notes.push(t) }, stop)).toBe(false);
      expect(notes[0]).toMatch(/couldn’t confirm that this engine’s processes stopped/);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toBe(3); // stopped retrying once confirmed
      expect(await finishEngine({} as never, { status: async () => void notes.push('x') }, async () => true)).toBe(true);
      expect(notes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('engine approvals on the timeline', () => {
  it('a stopped run allows nothing, even a call that needs no approval (W-122)', async () => {
    const store = fakeStore('approved');
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    const r = { ...run(store), autonomy: 'autonomous' as const, signal: AbortSignal.abort() };
    expect(await decide(r, writer, { callId: 'toolu_r', name: 'computer.read_file', args: { path: `${tmpdir()}/a.txt` }, title: 'Read a.txt', paths: [`${tmpdir()}/a.txt`] }, () => true)).toMatchObject({ allow: false });
  });

  it('a denied step stays denied after the engine reports it as an error', async () => {
    const store = fakeStore('denied');
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    expect(await decide(run(store), writer, call, () => true)).toMatchObject({ allow: false });
    await writer.toolEnd('toolu_1', 'The user denied this action. Do not retry it.', true);
    const step = [...store.rows.values()].find((r) => r.data?.name === 'computer.write_file')!;
    expect(step.status).toBe('denied');
    expect(step.data).toMatchObject({ risk: 'medium', approvalId: 'ap1', result: { output: 'Denied by the user.', isError: true } });
  });

  it("a sub-agent's permission prompt doesn't cut the message being written", async () => {
    const store = fakeStore('approved');
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    await writer.textDelta('The sub-agent has been laun');
    await decide(run(store), writer, { ...call, callId: 'toolu_sub' }, () => true); // unknown to the stream
    await writer.textDelta('ched in the background.');
    await writer.endMessage();
    const messages = [...store.rows.values()].filter((r) => r.data?.role === 'assistant');
    expect(messages.map((m) => m.data!.text)).toEqual(['The sub-agent has been launched in the background.']);
  });

  it("a request naming another call's id doesn't take over that step (W-121)", async () => {
    const store = fakeStore('denied');
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    await writer.toolStart('toolu_read', 'computer.read_file', { path: 'a.txt' }, 'Read a.txt');
    await decide(run(store), writer, { ...call, callId: 'toolu_read' }, () => true);
    const steps = [...store.rows.values()].filter((r) => r.data?.name);
    expect(steps.map((r) => [r.data!.name, r.status])).toEqual([
      ['computer.read_file', 'running'], // untouched
      ['computer.write_file', 'denied'], // its own step
    ]);
  });

  it('an approved step keeps its risk and approval when it finishes', async () => {
    const store = fakeStore('approved');
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    expect(await decide(run(store), writer, call, () => true)).toMatchObject({ allow: true });
    await writer.toolEnd('toolu_1', 'File created', false);
    const step = [...store.rows.values()].find((r) => r.data?.name === 'computer.write_file')!;
    expect(step.status).toBe('done');
    expect(step.data).toMatchObject({ risk: 'medium', approvalId: 'ap1', result: { output: 'File created', isError: false } });
  });
});
