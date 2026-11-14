import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A CLI engine's turn that a usage limit cut short: its session already holds the request, so the turn that
// carries on after the reset asks it to finish (keeping the turn's number) instead of sending the request again.
// A limit hit before the engine did anything leaves no mark, so the request simply goes again.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, dialog: {}, Notification: { isSupported: () => false }, safeStorage: {}, desktopCapturer: {}, screen: {} }));
vi.mock('../src/main/capabilities', () => ({ detect: async () => ({}) }));
vi.mock('../src/engines/images', () => ({ engineImages: async () => ({ images: [], skipped: [] }), withSkipped: (p: string) => p }));
const h = vi.hoisted(() => ({ runs: [] as { prompt: string; turn: number }[], outcome: {} as unknown }));
vi.mock('../src/engines/claude-code', () => ({
  runClaudeCode: async (run: { prompt: string; turn: number }) => (h.runs.push({ prompt: run.prompt, turn: run.turn }), h.outcome),
}));
const { DeviceRunner } = await import('../src/main/runner');

type Ev = { seq: number; type: string; status?: string; data: Record<string, unknown> };
let events: Ev[] = [];
const store = {
  lease: 'lease-1',
  events: async () => events,
  append: async (type: string, data: Record<string, unknown>, status?: string) => {
    events.push({ seq: events.length + 1, type, status, data });
    return { id: `e${events.length}` };
  },
};
const claim = { run: { id: 'run-1', model: { source: 'claude-code', model: 'sonnet' } }, agent: { name: 'Forge', autonomy: 'balanced', instructions: '' } };
const policy = { folders: [tmpdir()], shell: true, browser: false, screen: false, remoteApprovals: true, localModelUrl: '', launchAtLogin: false };
const limited = (midTurn: boolean) => ({ kind: 'paused', steps: 1, limit: { error: 'Claude Code: You’ve hit your limit', code: 'claude_usage_limit', resetAt: Date.now() + 3_600_000, midTurn } });
const runEngine = () =>
  (new DeviceRunner(() => {}, () => {}) as unknown as { runEngine: (...a: unknown[]) => Promise<{ kind: string }> }).runEngine(claim, store, policy, new AbortController().signal);
const user = (text: string) => events.push({ seq: events.length + 1, type: 'message', status: 'done', data: { role: 'user', text } });

beforeEach(() => {
  events = [];
  h.runs = [];
});

describe('a CLI engine after a usage limit', () => {
  it('carries on the cut-short turn after the reset, as the same turn', async () => {
    user('Tidy the notes folder');
    h.outcome = limited(true);
    expect(await runEngine()).toMatchObject({ kind: 'paused' });
    expect(h.runs).toEqual([{ prompt: 'Tidy the notes folder', turn: 1 }]);
    expect(events.at(-1)).toMatchObject({ type: 'reasoning', data: { engine: 'claude-code', consumedSeq: 1, interrupted: true, turn: 1 } });

    // The limit's status line (as finishRun writes it), then the reset: the turn carries on.
    events.push({ seq: events.length + 1, type: 'status', data: { code: 'usage_limit', text: 'Paused' } });
    h.outcome = { kind: 'completed', result: 'Done.', steps: 2 };
    expect(await runEngine()).toMatchObject({ kind: 'completed', seenSeq: 3 });
    expect(h.runs[1]).toEqual({ prompt: expect.stringMatching(/usage limit stopped you before you finished\. It has reset now: carry on/), turn: 1 });
    expect(events.at(-1)).toMatchObject({ type: 'reasoning', data: { consumedSeq: 3 } });
    expect(events.at(-1)?.data.interrupted).toBeUndefined();

    // The next turn is the user's next message, not another "carry on".
    user('Now archive the old ones');
    await runEngine();
    expect(h.runs[2]).toEqual({ prompt: 'Now archive the old ones', turn: 5 });
  });

  it('gives a message the user sent while it waited, saying the turn was cut short', async () => {
    user('Tidy the notes folder');
    h.outcome = limited(true);
    await runEngine();
    user('Skip the drafts folder');
    h.outcome = { kind: 'completed', result: 'Done.', steps: 1 };
    await runEngine();
    expect(h.runs[1]).toEqual({ prompt: expect.stringMatching(/stopped you before you finished\. It has reset now\. The user wrote this since; take it into account as you carry on:\n\nSkip the drafts folder$/), turn: 3 });
  });

  it('sends the request again when the limit came before the engine did anything', async () => {
    user('Tidy the notes folder');
    h.outcome = limited(false);
    await runEngine();
    expect(events.filter((e) => e.type === 'reasoning')).toEqual([]);
    h.outcome = { kind: 'completed', result: 'Done.', steps: 1 };
    await runEngine();
    expect(h.runs[1]).toEqual({ prompt: 'Tidy the notes folder', turn: 1 });
  });
});
