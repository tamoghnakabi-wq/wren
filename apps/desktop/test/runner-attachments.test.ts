import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Text files attached to a message reach a CLI engine in its prompt, read through the device API (only this
// run's account's files); a denial's reason reaches the desktop's own runs through the approval answer.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, dialog: {}, Notification: { isSupported: () => false }, safeStorage: {}, desktopCapturer: {}, screen: {} }));
vi.mock('../src/main/capabilities', () => ({ detect: async () => ({}) }));
vi.mock('../src/engines/images', () => ({ engineImages: async () => ({ images: [], skipped: [] }), withSkipped: (p: string) => p }));
const h = vi.hoisted(() => ({ prompts: [] as string[], asked: [] as { path: string; body: unknown; lease?: string }[], files: {} as Record<string, string>, approval: {} as Record<string, unknown> }));
vi.mock('../src/engines/claude-code', () => ({
  runClaudeCode: async (run: { prompt: string }) => (h.prompts.push(run.prompt), { kind: 'completed', result: 'Done.', steps: 1 }),
}));
vi.mock('../src/main/api', () => ({
  deviceFetch: async () => {
    throw new Error('not used');
  },
  deviceJson: async (path: string, body: { id?: string }, opts: { lease?: string } = {}) => {
    h.asked.push({ path, body, lease: opts.lease });
    if (path.endsWith('/artifact')) {
      const text = h.files[body.id!];
      return text === undefined ? { found: false } : { found: true, mime: 'text/plain', data: Buffer.from(text).toString('base64') };
    }
    if (path.endsWith('/approval-state')) return h.approval;
    throw new Error(`unexpected ${path}`);
  },
}));
const { DeviceRunner } = await import('../src/main/runner');
const { RemoteStore } = await import('../src/main/remote');

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
const policy = { folders: [tmpdir()], shell: true, browser: false, screen: false, remoteApprovals: true, localModelUrl: '', launchAtLogin: false, keepAwake: true };
const runEngine = () =>
  (new DeviceRunner(() => {}, () => {}) as unknown as { runEngine: (...a: unknown[]) => Promise<{ kind: string }> }).runEngine(claim, store, policy, new AbortController().signal);
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

beforeEach(() => {
  events = [];
  h.prompts = [];
  h.asked = [];
  h.files = {};
});

describe('attached files in an engine’s prompt', () => {
  it('gives the engine a text file’s contents and names what it can’t read', async () => {
    h.files[id(1)] = 'line one\nline two';
    const attachments = [
      { artifactId: id(1), name: 'Pasted text 1.txt', mime: 'text/plain', size: 17 },
      { artifactId: id(2), name: 'deck.pdf', mime: 'application/pdf', size: 900 },
    ];
    events.push({ seq: 1, type: 'message', status: 'done', data: { role: 'user', text: 'Sum this up\n\n[Attached files: Pasted text 1.txt, deck.pdf]', attachments } });
    expect(await runEngine()).toMatchObject({ kind: 'completed' });
    expect(h.prompts[0]).toContain('<attached-file name="Pasted text 1.txt">\nline one\nline two\n</attached-file>');
    expect(h.prompts[0]).toContain("[Wren can't give you the contents of: deck.pdf (not a text file).]");
    // Only the text file is asked for, with the run's lease.
    expect(h.asked.filter((a) => a.path.endsWith('/artifact'))).toEqual([{ path: '/api/device/runs/run-1/artifact', body: { id: id(1) }, lease: 'lease-1' }]);
    // The saved message keeps only what the user wrote.
    expect(events[0].data.text).toBe('Sum this up\n\n[Attached files: Pasted text 1.txt, deck.pdf]');
  });

  it('sends a message without files as it was', async () => {
    events.push({ seq: 1, type: 'message', status: 'done', data: { role: 'user', text: 'Tidy the notes folder' } });
    await runEngine();
    expect(h.prompts).toEqual(['Tidy the notes folder']);
    expect(h.asked).toEqual([]);
  });
});

describe('a denial’s reason on the desktop', () => {
  it('comes with the denied state and is kept for that approval', async () => {
    const s = new RemoteStore('run-1', 'lease-1');
    h.approval = { state: 'denied', note: 'Use the staging database.' };
    expect(await s.approvalState(id(3))).toBe('denied');
    expect(await s.approvalNote(id(3))).toBe('Use the staging database.');
    h.approval = { state: 'denied' }; // a server before 0.1.49 sends none
    expect(await s.approvalState(id(4))).toBe('denied');
    expect(await s.approvalNote(id(4))).toBeUndefined();
  });
});
