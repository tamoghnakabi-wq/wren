import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A resumed Grok session replays the conversation (ACP session/load) before answering; that history must not be
// written into the timeline again. The engine runs here against a fake `grok agent stdio`.

const AGENT = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const update = (sessionId, u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const text = (sessionId, t) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, authMethods: [{ id: 'cached_token' }] } });
  if (m.method === 'authenticate') return out({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'session/new') return out({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's-new' } });
  if (m.method === 'session/load') {
    const s = m.params.sessionId;
    if (s === 'gone') return out({ jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'Session not found' } });
    if (s === 'crash') process.exit(3); // the CLI dies mid-request
    if (s === 'hang') return; // never answers
    // the whole earlier conversation, as ACP requires, then the answer
    update(s, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } });
    text(s, 'Old reply.');
    update(s, { sessionUpdate: 'tool_call', toolCallId: 'old-1', title: 'Execute old', kind: 'execute', status: 'completed', rawInput: { command: 'echo old' }, content: [{ type: 'content', content: { type: 'text', text: 'old' } }] });
    text(s, 'Old answer.');
    return out({ jsonrpc: '2.0', id: m.id, result: {} });
  }
  if (m.method === 'session/prompt') {
    const s = m.params.sessionId;
    if (m.params.prompt[0].text.includes('hang')) return; // never answers, ignores session/cancel too
    const parts = m.params.prompt.map((b) => (b.type === 'text' ? b.text : b.type + ':' + b.mimeType + ':' + b.data));
    if (parts.length > 1 || m.params.prompt[0].text.includes('[The user attached')) {
      if (m.params.prompt[0].text.includes('picky') && parts.length > 1) return out({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Invalid params: image content is not supported' } });
      if (m.params.prompt[0].text.includes('late') && parts.length > 1) {
        // Work first, then an error that looks like an image refusal: asking again could repeat the work.
        update(s, { sessionUpdate: 'tool_call', toolCallId: 'late-1', title: 'Write file', kind: 'edit', status: 'completed', rawInput: { path: 'a.txt' } });
        return out({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Invalid params: image too large' } });
      }
      text(s, parts.join(' | '));
      return out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    }
    text(s, 'New reply.');
    update(s, { sessionUpdate: 'tool_call', toolCallId: 'new-1', title: 'Execute new', kind: 'execute', status: 'pending', rawInput: { command: 'echo new' } });
    update(s, { sessionUpdate: 'tool_call_update', toolCallId: 'new-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'new' } }] });
    update(s, { sessionUpdate: 'tool_call', toolCallId: 'new-2', title: 'Read notes', kind: 'read', status: 'completed', rawInput: { path: 'notes.md' }, content: [{ type: 'content', content: { type: 'text', text: 'notes' } }] });
    text(s, 'Done.');
    return out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
  }
  if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;
const dir = mkdtempSync(join(tmpdir(), 'wren-grok-test-'));
const agentPath = join(dir, 'fake-grok.cjs');
writeFileSync(agentPath, AGENT);

const h = vi.hoisted(() => ({ log: [] as string[], spawned: 0 }));
vi.mock('../src/engines/common', () => {
  class TimelineWriter {
    text = '';
    constructor(..._args: unknown[]) {}
    async textDelta(d: string) {
      this.text += d;
      h.log.push(`text:${d}`);
    }
    async endMessage() {
      if (this.text) h.log.push(`message:${this.text}`);
      this.text = '';
    }
    async toolStart(callId: string) {
      await this.endMessage();
      h.log.push(`start:${callId}`);
      return callId;
    }
    async toolEnd(callId: string, output: string, isError: boolean) {
      h.log.push(`end:${callId}:${output}${isError ? ':error' : ''}`);
    }
    get currentText() {
      return this.text;
    }
  }
  return {
    TimelineWriter,
    findCli: () => '/fake/grok',
    decide: async () => ({ allow: true }),
    startApprovalBridge: async () => ({ url: 'http://127.0.0.1:9', token: 't', close() {} }),
    spawnEngine: async () => (h.spawned++, spawn(process.execPath, [agentPath], { stdio: ['pipe', 'pipe', 'pipe'] })),
    stopEngine: async (p: { kill: () => void }) => p.kill(),
    finishEngine: async (p: { kill: () => void }) => (p.kill(), true),
  };
});
const { runGrokBuild } = await import('../src/engines/grok-build');

const run = (resumeId?: string, prompt = 'how are you', images?: { mime: string; data: string }[]) => {
  const saved: string[] = [];
  const abort = new AbortController();
  return {
    saved,
    abort,
    run: {
      runId: `r-${Math.random().toString(36).slice(2)}`,
      store: { usageSource: '', append: async () => ({ id: 'e' }), update: async () => {} } as never,
      agentName: 'chitti',
      autonomy: 'balanced' as const,
      instructions: '',
      model: 'default',
      prompt,
      images,
      cwd: dir,
      folders: [dir],
      allow: { shell: true, browser: true, screen: true },
      resumeId,
      signal: abort.signal,
      saveResumeId: async (id: string) => void saved.push(id),
    },
  };
};

beforeEach(() => {
  h.log = [];
});

describe('Grok Build follow-ups', () => {
  it('writes only the new turn when a session is resumed, not the history it replays', async () => {
    const { run: r } = run('s-old');
    const outcome = await runGrokBuild(r, () => true, '/dev/null');
    expect(outcome).toMatchObject({ kind: 'completed', result: 'Done.' });
    expect(h.log.join('\n')).not.toMatch(/Old|old-1/);
    expect(h.log).toEqual(['text:New reply.', 'message:New reply.', 'start:new-1', 'end:new-1:new', 'start:new-2', 'end:new-2:notes', 'text:Done.', 'message:Done.']);
  });

  it('closes a tool call that arrives already finished', async () => {
    const { run: r } = run();
    await runGrokBuild(r, () => true, '/dev/null');
    expect(h.log).toContain('end:new-2:notes');
  });

  it('ends the run when grok exits in the middle of a request (W-116)', async () => {
    const { run: r } = run('crash');
    const outcome = await runGrokBuild(r, () => true, '/dev/null');
    expect(outcome).toMatchObject({ kind: 'failed', code: 'engine_error' });
    expect(h.log).toEqual([]);
  });

  it('ends the run when the user stops it while grok gives no answer (W-116)', async () => {
    for (const [resumeId, prompt] of [['hang', 'how are you'], [undefined, 'hang please']] as const) {
      const { run: r, abort } = run(resumeId, prompt);
      const started = Date.now();
      setTimeout(() => abort.abort(), 300);
      const outcome = await runGrokBuild(r, () => true, '/dev/null');
      expect(outcome, String(resumeId)).toMatchObject({ kind: 'cancelled' });
      expect(Date.now() - started).toBeLessThan(8000);
    }
  }, 20_000);

  it('sends attached images as ACP image blocks', async () => {
    const { run: r } = run(undefined, 'What is this?', [{ mime: 'image/png', data: 'iVBORw0' }]);
    expect(await runGrokBuild(r, () => true, '/dev/null')).toMatchObject({ kind: 'completed', result: 'What is this? | image:image/png:iVBORw0' });
  });

  it('asks again without them, saying so, when Grok refuses images', async () => {
    const { run: r } = run(undefined, 'picky: what is this?', [{ mime: 'image/png', data: 'iVBORw0' }]);
    const outcome = await runGrokBuild(r, () => true, '/dev/null');
    expect(outcome).toMatchObject({ kind: 'completed' });
    expect((outcome as { result: string }).result).toMatch(/^picky: what is this\?\n\n\[The user attached an image, but this version of Grok Build couldn’t receive it\.\]$/);
  });

  it('does not ask again once the prompt has done something (W-123)', async () => {
    const { run: r } = run(undefined, 'late: what is this?', [{ mime: 'image/png', data: 'iVBORw0' }]);
    const outcome = await runGrokBuild(r, () => true, '/dev/null');
    expect(outcome).toMatchObject({ kind: 'failed', code: 'engine_error' });
    expect(h.log.filter((l) => l.startsWith('start:'))).toEqual(['start:late-1']); // the prompt ran once
  });

  it('never starts Grok for a run stopped before it began (W-122)', async () => {
    const { run: r, abort } = run();
    abort.abort();
    h.spawned = 0;
    expect(await runGrokBuild(r, () => true, '/dev/null')).toMatchObject({ kind: 'cancelled' });
    expect(h.spawned).toBe(0);
  });

  it('starts a new session when the old one is gone, and remembers it', async () => {
    const { run: r, saved } = run('gone');
    const outcome = await runGrokBuild(r, () => true, '/dev/null');
    expect(outcome).toMatchObject({ kind: 'completed' });
    expect(saved).toEqual(['s-new']);
    expect(h.log[0]).toBe('text:New reply.');
  });
});
