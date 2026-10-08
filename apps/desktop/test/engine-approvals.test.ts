import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
const { decide, TimelineWriter } = await import('../src/engines/common');

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

describe('engine approvals on the timeline', () => {
  it('a denied step stays denied after the engine reports it as an error', async () => {
    const store = fakeStore('denied');
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    expect(await decide(run(store), writer, call, () => true)).toMatchObject({ allow: false });
    await writer.toolEnd('toolu_1', 'The user denied this action. Do not retry it.', true);
    const step = [...store.rows.values()].find((r) => r.data?.name === 'computer.write_file')!;
    expect(step.status).toBe('denied');
    expect(step.data).toMatchObject({ risk: 'medium', approvalId: 'ap1', result: { output: 'Denied by the user.', isError: true } });
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
