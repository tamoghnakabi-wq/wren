import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
process.env.WREN_DATA_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'wren-data-')));
const { decide, secretThroughWren, TimelineWriter, writeSecretFile } = await import('../src/engines/common');
const { makeRunTemp } = await import('../src/main/sandbox');

// Claude Code asking for a secret (request_secret) and setting a task for later (schedule), 0.1.55.

function fakeStore(o: { answers?: ('saved' | 'declined' | null)[]; secrets?: { name: string; value: string }[]; approval?: 'approved' | 'denied' } = {}) {
  const rows = new Map<string, { status?: string; data?: Record<string, unknown> }>();
  const answers = [...(o.answers ?? [])];
  let n = 0;
  return {
    rows,
    notes: [] as string[],
    approvals: 0,
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
    async notify(title: string) {
      this.notes.push(title);
    },
    async secretAnswer() {
      return answers.length > 1 ? answers.shift()! : (answers[0] ?? null);
    },
    async secrets() {
      return o.secrets ?? [];
    },
    async createApproval() {
      this.approvals++;
      return 'ap1';
    },
    async approvalState() {
      return o.approval ?? 'approved';
    },
  };
}

const run = (store: unknown, extra: Record<string, unknown> = {}) => ({
  runId: `r-${Math.random().toString(36).slice(2)}`,
  engine: 'claude-code' as const,
  store: store as never,
  agentName: 'a',
  autonomy: 'autonomous' as const,
  instructions: '',
  model: 'default',
  prompt: '',
  cwd: tmpdir(),
  folders: [tmpdir()],
  allow: { shell: true, browser: true, screen: true },
  signal: new AbortController().signal,
  saveResumeId: async () => {},
  ...extra,
});

describe('a secret file for an engine', () => {
  it('is new, private and in the run’s own temp folder, whatever an agent left there', () => {
    const runId = `secret-run-${Math.random().toString(36).slice(2)}`;
    const temp = makeRunTemp(runId);
    // A link an agent might plant where a predictable name would be: never followed.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'outside-')));
    symlinkSync(outside, join(temp, 'secret-planted'));
    const file = writeSecretFile(runId, 'TOKEN', 'tok_123456');
    expect(dirname(dirname(file))).toBe(temp);
    expect(lstatSync(dirname(file)).isSymbolicLink()).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('tok_123456');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(existsSync(join(outside, 'TOKEN'))).toBe(false);
    // Each time a folder of its own.
    expect(dirname(writeSecretFile(runId, 'TOKEN', 'again'))).not.toBe(dirname(file));
  });
});

describe('Claude Code asking for a secret', () => {
  it('turns its step into a card, waits for the answer and names the file, never the value', async () => {
    const store = fakeStore({ answers: [null, null, 'saved'], secrets: [] });
    const r = run(store);
    const writer = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    // The CLI's stream showed the call first.
    await writer.toolStart('toolu_s', 'task.request_secret', { name: 'API_TOKEN', why: 'x' }, 'Ask for a secret: API_TOKEN');
    let saved = false;
    Object.assign(store, { secrets: async () => (saved ? [{ name: 'API_TOKEN', value: 'tok_abcdef' }] : []) });
    const answer = secretThroughWren(r, writer, { name: 'API_TOKEN', why: 'The deploy token.', signal: new AbortController().signal }, { pollMs: 5, stepWaitMs: 0 });
    await new Promise((res) => setTimeout(res, 2));
    saved = true;
    const out = await answer;
    expect(out.isError).toBeUndefined();
    expect(out.text).not.toContain('tok_abcdef');
    const file = /in the file (.+?), for this task only/.exec(out.text)![1];
    expect(readFileSync(file, 'utf8')).toBe('tok_abcdef');
    const step = [...store.rows.values()][0];
    expect(step).toMatchObject({ status: 'awaiting_secret', data: { name: 'task.request_secret', args: { name: 'API_TOKEN', why: 'The deploy token.' } } });
    expect(store.notes).toEqual(['Your agent needs a secret']);
  });

  it('says when the user declines, refuses a reserved name, and stops with the task', async () => {
    const declined = fakeStore({ answers: ['declined'] });
    const w = new TimelineWriter(declined as never, 'claude-code', 'Claude Code');
    expect(await secretThroughWren(run(declined), w, { name: 'API_TOKEN', why: 'x', signal: new AbortController().signal }, { pollMs: 1, stepWaitMs: 0 })).toMatchObject({ isError: true, text: expect.stringContaining('declined') });
    expect(await secretThroughWren(run(declined), w, { name: 'LD_PRELOAD', why: 'x', signal: new AbortController().signal })).toMatchObject({ isError: true, text: expect.stringContaining('something else') });
    const stopped = fakeStore({ answers: [null] });
    const ws = new TimelineWriter(stopped as never, 'claude-code', 'Claude Code');
    const ac = new AbortController();
    const waiting = secretThroughWren(run(stopped, { signal: ac.signal }), ws, { name: 'API_TOKEN', why: 'x', signal: new AbortController().signal }, { pollMs: 5, stepWaitMs: 0 });
    setTimeout(() => ac.abort(), 10);
    expect(await waiting).toMatchObject({ isError: true, text: expect.stringContaining('Stopped') });
    expect([...stopped.rows.values()][0].status).toBe('cancelled');
  });

  it('gives one saved earlier in the task at once', async () => {
    const store = fakeStore({ secrets: [{ name: 'API_TOKEN', value: 'tok_earlier' }] });
    const w = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    const out = await secretThroughWren(run(store), w, { name: 'API_TOKEN', why: 'x', signal: new AbortController().signal });
    expect(readFileSync(/in the file (.+?), for this task only/.exec(out.text)![1], 'utf8')).toBe('tok_earlier');
    expect(store.rows.size).toBe(0);
  });
});

describe('Claude Code setting a task for later', () => {
  it('is asked about every time, even for an autonomous agent', async () => {
    const store = fakeStore();
    const w = new TimelineWriter(store as never, 'claude-code', 'Claude Code');
    const d = await decide(run(store), w, { callId: 'perm-1', name: 'task.schedule', args: { when: '2026-11-27T17:00:00+11:00', task: 'Remind me' }, title: 'Schedule', paths: [] }, () => true);
    expect(d).toMatchObject({ allow: true });
    expect(store.approvals).toBe(1);
    const denied = fakeStore({ approval: 'denied' });
    const wd = new TimelineWriter(denied as never, 'claude-code', 'Claude Code');
    expect(await decide(run(denied), wd, { callId: 'perm-2', name: 'task.schedule', args: { when: 'x', task: 'y' }, title: 'Schedule', paths: [] }, () => true)).toMatchObject({ allow: false });
  });
});
