import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { agMetadata, agModelName, agRecords, claudeLine, codexText, grokLine, openCodeRow, protoFields } from '../src/main/local-usage/parse';
import { localDay, scan, tierOf, windowStart, type LocalUsageReport } from '../src/main/local-usage/scan';

// Usage → This Mac (0.1.53): the desktop reads the token usage other AI apps log on this computer. Only
// usage fields are read; the same request logged twice counts once; links aren't followed.

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const J = (o: unknown) => JSON.stringify(o);

const claude = (o: { id?: string; req?: string; session?: string; model?: string; minutesAgo?: number; usage?: Record<string, unknown>; type?: string }) =>
  J({
    type: o.type ?? 'assistant',
    timestamp: iso(o.minutesAgo ?? 10),
    sessionId: o.session ?? 's1',
    requestId: o.req ?? 'req_1',
    message: { id: o.id ?? 'msg_1', model: o.model ?? 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'secret words' }], usage: o.usage ?? { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 } },
  });

describe('Claude Code lines', () => {
  it('reads an assistant message’s usage and its key', () => {
    const [r] = claudeLine(claude({ usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 150 }, output_tokens: 50, speed: 'fast' } }));
    expect(r).toMatchObject({ model: 'claude-opus-5-5', session: 's1', input: 10, cacheRead: 1000, cacheWrite: 200, cacheWrite1h: 150, output: 50, speed: 'fast', key: 'claude:msg_1:req_1' });
  });

  it('skips user lines, placeholders and malformed lines', () => {
    expect(claudeLine(claude({ type: 'user' }))).toEqual([]);
    expect(claudeLine(claude({ model: '<synthetic>' }))).toEqual([]);
    expect(claudeLine('{"usage": oops')).toEqual([]);
    expect(claudeLine('{"type":"summary"}')).toEqual([]);
  });

  it('counts an advisor call under its own model', () => {
    const recs = claudeLine(claude({ usage: { input_tokens: 5, output_tokens: 5, iterations: [{ type: 'advisor_message', model: 'claude-fable-5-2', input_tokens: 70, output_tokens: 30 }] } }));
    expect(recs.map((r) => [r.model, r.input, r.output, r.key])).toEqual([
      ['claude-opus-5-5', 5, 5, 'claude:msg_1:req_1'],
      ['claude-fable-5-2', 70, 30, 'claude:msg_1:req_1:advisor:0'],
    ]);
  });
});

const meta = (extra: Record<string, unknown> = {}, minutesAgo = 60) => J({ timestamp: iso(minutesAgo), type: 'session_meta', payload: { id: 'cx1', model_provider: 'openai', ...extra } });
const turn = (model: string, minutesAgo = 59) => J({ timestamp: iso(minutesAgo), type: 'turn_context', payload: { model, turn_id: 't' } });
const u = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });
const rec = (id: string | null, usage: unknown, minutesAgo = 58) => J({ timestamp: iso(minutesAgo), type: 'token_usage_record', payload: { ...(id ? { response_id: id } : {}), usage } });
const snap = (last: unknown, total: unknown, minutesAgo = 58) => J({ timestamp: iso(minutesAgo), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } } });

describe('Codex rollouts', () => {
  it('counts request records and only follows the snapshots after them', () => {
    const text = [meta(), turn('gpt-6.1-sol'), rec('r1', u(100, 60, 10)), snap(u(100, 60, 10), u(100, 60, 10)), rec('r2', u(200, 150, 20)), snap(u(200, 150, 20), u(300, 210, 30)), snap(u(200, 150, 20), u(300, 210, 30))].join('\n');
    const recs = codexText(text);
    expect(recs.map((r) => [r.key, r.input, r.cacheRead, r.output, r.model, r.session])).toEqual([
      ['codex:r1', 40, 60, 10, 'gpt-6.1-sol', 'cx1'],
      ['codex:r2', 50, 150, 20, 'gpt-6.1-sol', 'cx1'],
    ]);
  });

  it('counts older snapshot-only logs once each, skipping repeats and replayed totals', () => {
    const text = [meta(), turn('gpt-5.5'), snap(u(100, 0, 10), u(100, 0, 10)), snap(u(100, 0, 10), u(100, 0, 10)), snap(u(50, 0, 5), u(150, 0, 15)), snap(u(50, 0, 5), u(120, 0, 12), 57), snap(u(10, 0, 1), u(160, 0, 16), 56)].join('\n');
    expect(codexText(text).map((r) => r.input + r.output)).toEqual([110, 55, 11]);
  });

  it('a fork’s copied burst only sets the running total', () => {
    const text = [meta({ forked_from_id: 'parent' }, 60), turn('gpt-5.5', 60), snap(u(100, 0, 10), u(100, 0, 10), 60), snap(u(40, 0, 4), u(140, 0, 14), 60), turn('gpt-5.5', 30), snap(u(5, 0, 1), u(145, 0, 15), 30)].join('\n');
    expect(codexText(text).map((r) => r.input + r.output)).toEqual([6]);
  });

  it('needs a model and reads the service tier', () => {
    expect(codexText([meta(), rec('r1', u(10, 0, 1))].join('\n'))).toEqual([]);
    const fast = [meta(), turn('gpt-6-sol'), J({ timestamp: iso(58), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { service_tier: 'priority' } } }), rec('r1', u(10, 0, 1))].join('\n');
    expect(codexText(fast)[0].speed).toBe('fast');
  });
});

describe('Grok Build updates', () => {
  const line = (usage: Record<string, unknown>) => J({ params: { sessionId: 'g1', _meta: { agentTimestampMs: now - 1000 }, update: { sessionUpdate: 'turn_completed', prompt_id: 'p1', usage } } });
  it('splits by model and turns cost ticks into dollars', () => {
    const recs = grokLine(line({ inputTokens: 300, outputTokens: 30, costUsdTicks: 20_000_000_000, modelUsage: { 'grok-4.7': { inputTokens: 200, cachedReadTokens: 50, outputTokens: 20, costUsdTicks: 15_000_000_000 }, 'grok-mini': { inputTokens: 100, outputTokens: 10 } } }));
    expect(recs.map((r) => [r.model, r.input, r.cacheRead, r.output, r.costUsd])).toEqual([
      ['grok-4.7', 150, 50, 20, 1.5],
      ['grok-mini', 100, 0, 10, 0.5],
    ]);
  });
  it('ignores other updates', () => {
    expect(grokLine(J({ params: { update: { sessionUpdate: 'agent_message_chunk' } } }))).toEqual([]);
  });
});

describe('OpenCode messages', () => {
  it('counts reasoning as output and treats a zero cost as unreported', () => {
    const r = openCodeRow(J({ tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 7, write: 2 } }, cost: 0, modelID: 'gpt-5.5', time: { created: now } }), 'o1', null);
    expect(r).toMatchObject({ model: 'gpt-5.5', input: 10, output: 8, reasoning: 3, cacheRead: 7, cacheWrite: 2, costUsd: null, session: 'o1' });
  });
});

// A tiny protobuf writer for Antigravity's blobs.
const varint = (n: number) => {
  const b: number[] = [];
  while (n >= 128) {
    b.push((n % 128) | 128);
    n = Math.floor(n / 128);
  }
  b.push(n);
  return b;
};
const f = (num: number, v: number | string | Uint8Array): number[] => {
  if (typeof v === 'number') return [...varint(num * 8), ...varint(v)];
  const bytes = typeof v === 'string' ? [...Buffer.from(v)] : [...v];
  return [...varint(num * 8 + 2), ...varint(bytes.length), ...bytes];
};
const pb = (...fields: number[][]) => Uint8Array.from(fields.flat());

describe('Antigravity conversations', () => {
  const seconds = Math.floor(now / 1000) - 120;
  const usage = (id: string) => pb(f(1, 1417), f(2, 1000), f(3, 40), f(4, 0), f(5, 9000), f(9, 10), f(11, id));
  const step = pb(f(24, pb(f(1, 1417), f(12, 'Gemini 4 Argon (High)'))), f(9, usage('call-1')), f(8, pb(f(1, seconds))));
  const gen = pb(f(1, pb(f(3, 1417), f(4, usage('call-1')), f(9, pb(f(4, pb(f(1, seconds))))))));

  it('reads protobuf fields', () => {
    const fields = protoFields(pb(f(1, 300), f(2, 'hi')));
    expect(fields.get(1)).toEqual([300]);
    expect(Buffer.from(fields.get(2)![0] as Uint8Array).toString()).toBe('hi');
    expect(() => protoFields(Uint8Array.from([0x0a, 0x05, 0x01]))).toThrow();
  });

  it('names models as the price list does', () => {
    expect(agModelName('Gemini 4 Argon (High)')).toBe('gemini-4-argon');
    expect(agModelName('Claude 4.5 Sonnet (Thinking)')).toBe('claude-sonnet-4-5');
  });

  it('counts a request logged as a step and as a generation once', () => {
    const recs = agRecords('conv', [{ ...agMetadata(step, true), idx: 0 }], [{ ...agMetadata(gen, false), idx: 0 }], now, new Map());
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ model: 'gemini-4-argon', input: 1000, cacheRead: 9000, output: 40, reasoning: 10, ts: seconds * 1000, key: 'antigravity:call-1' });
  });
});

describe('the scan of this computer', () => {
  const home = mkdtempSync(join(tmpdir(), 'wren-lu-home-'));
  const data = mkdtempSync(join(tmpdir(), 'wren-lu-data-'));
  const outside = mkdtempSync(join(tmpdir(), 'wren-lu-outside-'));
  afterAll(() => {
    for (const d of [home, data, outside]) rmSync(d, { recursive: true, force: true });
  });
  const put = (rel: string, body: string | Buffer) => {
    const p = join(home, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
    return p;
  };

  // Claude: a message written per content block (partial usage first), and a resumed session copying it.
  put('.claude/projects/proj/s1.jsonl', [J({ type: 'user', message: { content: 'hello' } }), claude({ usage: { input_tokens: 10, output_tokens: 1 } }), claude({ usage: { input_tokens: 10, output_tokens: 50 } }), claude({ id: 'msg_2', req: 'req_2', usage: { input_tokens: 5, output_tokens: 5 } })].join('\n'));
  put('.claude/projects/proj/s2.jsonl', [claude({ session: 's2', usage: { input_tokens: 10, output_tokens: 50 } }), claude({ session: 's2', id: 'msg_3', req: 'req_3', usage: { input_tokens: 100, output_tokens: 100 } })].join('\n'));
  // Untouched for 200 days: outside the window.
  const old = put('.claude/projects/old/s0.jsonl', claude({ id: 'msg_old', req: 'req_old', minutesAgo: 200 * 24 * 60 }));
  utimesSync(old, new Date(now - 200 * 864e5), new Date(now - 200 * 864e5));
  // A link out of the folder isn't followed.
  writeFileSync(join(outside, 'x.jsonl'), claude({ id: 'msg_x', req: 'req_x' }));
  symlinkSync(outside, join(home, '.claude/projects/linked'));
  // Codex, compressed.
  put('.codex/sessions/2026/11/20/rollout-a.jsonl.zst', zstdCompressSync(Buffer.from([meta(), turn('gpt-6.1-sol'), rec('r1', u(100, 60, 10)), snap(u(100, 60, 10), u(100, 60, 10))].join('\n'))));
  // Grok Build.
  put('.grok/sessions/g1/updates.jsonl', J({ params: { sessionId: 'g1', _meta: { agentTimestampMs: now - 5000 }, update: { sessionUpdate: 'turn_completed', prompt_id: 'p', usage: { inputTokens: 40, outputTokens: 4, costUsdTicks: 10_000_000_000, modelUsage: { 'grok-4.7': { inputTokens: 40, outputTokens: 4, costUsdTicks: 10_000_000_000 } } } } } }));
  // OpenCode: a message table, and an account table Wren never reads.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite');
  mkdirSync(join(home, '.local/share/opencode'), { recursive: true });
  const db = new DatabaseSync(join(home, '.local/share/opencode/opencode.db'));
  db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE account (access_token TEXT)');
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m1', 'oc1', now, J({ role: 'assistant', modelID: 'gpt-5.5', tokens: { input: 20, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now } }));
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m2', 'oc1', now, J({ role: 'user', time: { created: now } }));
  db.exec("INSERT INTO account VALUES ('do-not-read')");
  db.close();

  const sum = (r: LocalUsageReport, app: string) => r.rows.filter((x) => x.app === app).reduce((n, x) => n + x.input + x.cacheRead + x.cacheWrite + x.output, 0);
  let first: LocalUsageReport;

  it('finds each app and counts each request once', async () => {
    first = await scan({ home, dataDir: data, env: {}, now });
    expect(Object.fromEntries(first.apps.map((a) => [a.id, a.found]))).toEqual({ 'claude-code': true, codex: true, 'grok-build': true, antigravity: false, opencode: true });
    // msg_1 (largest of its copies: 60), msg_2 (10), msg_3 (200); not the old file or the linked one.
    expect(sum(first, 'claude-code')).toBe(270);
    expect(sum(first, 'codex')).toBe(110);
    expect(sum(first, 'grok-build')).toBe(44);
    expect(first.rows.find((x) => x.app === 'grok-build')?.costUsd).toBe(1);
    expect(sum(first, 'opencode')).toBe(22);
    expect(first.sessions.filter(([a]) => a === 'claude-code')).toHaveLength(2);
    expect(first.days).toHaveLength(90);
    expect(first.days.at(-1)).toBe(localDay(now));
    expect(first.apps.find((a) => a.id === 'claude-code')?.files).toBe(2);
  });

  it('keeps a cache that never holds message text, and rereads only changed files', async () => {
    const cache = readFileSync(join(data, 'local-usage.json'), 'utf8');
    expect(cache).not.toContain('secret words');
    expect(cache).not.toContain('do-not-read');
    const again = await scan({ home, dataDir: data, env: {}, now });
    expect(sum(again, 'claude-code')).toBe(270);
    put('.claude/projects/proj/s3.jsonl', claude({ session: 's3', id: 'msg_4', req: 'req_4', usage: { input_tokens: 1, output_tokens: 1 } }));
    const grown = await scan({ home, dataDir: data, env: {}, now });
    expect(sum(grown, 'claude-code')).toBe(272);
  });

  it('days and prompt tiers', () => {
    expect(windowStart(now)).toBeLessThanOrEqual(now - 89 * 864e5);
    const base = { ts: 0, model: '', session: '', cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, speed: 'standard' as const, costUsd: null, key: null };
    expect(tierOf({ ...base, input: 1000, cacheRead: 0 })).toBe(0);
    expect(tierOf({ ...base, input: 1000, cacheRead: 250_000 })).toBe(200_000);
    expect(tierOf({ ...base, input: 0, cacheRead: 300_000 })).toBe(272_000);
  });
});
