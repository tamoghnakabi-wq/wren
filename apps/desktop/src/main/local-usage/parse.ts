// Reads token usage out of the logs other AI apps keep on this computer (Claude Code, Codex, Grok Build,
// OpenCode, Antigravity). Only the usage fields are read: never message text. Formats were worked out
// from the files themselves and from T3 Code's readers (MIT, github.com/pingdotgg/t3code), which also
// supplied Antigravity's model numbers.

export type AppId = 'claude-code' | 'codex' | 'grok-build' | 'opencode' | 'antigravity';
/** Faster service at a higher price: Claude's fast mode, OpenAI's priority tier (fast) and ultrafast. */
export type Speed = 'standard' | 'fast' | 'ultrafast';

/** One model request as the app logged it. `output` includes `reasoning`. */
export interface UsageRec {
  ts: number;
  model: string;
  session: string;
  /** Input not read from or written to the prompt cache. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** The part of `cacheWrite` kept for an hour (priced higher). */
  cacheWrite1h: number;
  output: number;
  reasoning: number;
  speed: Speed;
  /** The cost the app itself recorded, when it did. */
  costUsd: number | null;
  /** The same request seen again (repeated content blocks, history copied into another file). */
  key: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** A token count: whole, finite, not negative. Anything else is 0. */
export const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
const isoMs = (v: unknown): number | null => {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};
const money = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const parse = (line: string): Obj | null => {
  try {
    return obj(JSON.parse(line));
  } catch {
    return null;
  }
};
export const total = (r: UsageRec) => r.input + r.cacheRead + r.cacheWrite + r.output;

// ------------------------------------------------------------------ Claude Code
// ~/.claude/projects/<project>/<session>.jsonl (and subagent files beside it). Each assistant message
// carries `message.usage`; a message with several content blocks is written once per block, and a
// resumed session copies earlier messages into its new file, so `message.id:requestId` repeats.

/** Claude Code's model for placeholders that never reached the API. */
const SYNTHETIC = '<synthetic>';

export function claudeLine(line: string): UsageRec[] {
  if (!line.includes('"usage"')) return [];
  const o = parse(line);
  if (!o || o.type !== 'assistant') return [];
  const m = obj(o.message);
  const u = obj(m?.usage);
  const ts = isoMs(o.timestamp);
  const model = str(m?.model);
  if (!m || !u || ts === null || !model || model === SYNTHETIC) return [];
  const id = str(m.id);
  const req = str(o.requestId);
  const key = id || req ? `claude:${id}:${req}` : null;
  const session = str(o.sessionId);
  const speed: Speed = u.speed === 'fast' ? 'fast' : 'standard';
  const one = (x: Obj, model: string, key: string | null, costUsd: number | null): UsageRec => ({
    ts,
    model,
    session,
    input: count(x.input_tokens),
    cacheRead: count(x.cache_read_input_tokens),
    cacheWrite: count(x.cache_creation_input_tokens),
    cacheWrite1h: Math.min(count(obj(x.cache_creation)?.ephemeral_1h_input_tokens), count(x.cache_creation_input_tokens)),
    output: count(x.output_tokens),
    reasoning: 0,
    speed,
    costUsd,
    key,
  });
  const out = [one(u, model, key, money(o.costUSD))];
  // Advisor calls run on another model and appear only in `iterations`.
  const iterations = Array.isArray(u.iterations) ? u.iterations : [];
  iterations.forEach((it, i) => {
    const a = obj(it);
    const am = str(a?.model);
    if (a?.type === 'advisor_message' && am && am !== SYNTHETIC) out.push(one(a, am, key && `${key}:advisor:${i}`, null));
  });
  return out.filter((r) => total(r) > 0);
}

// ------------------------------------------------------------------ Codex
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, most compressed as .jsonl.zst. The model comes from the
// latest `turn_context`. Newer Codex logs each request as a `token_usage_record` with a response id,
// followed by a `token_count` snapshot; older logs have only the snapshots, whose `last_token_usage` is
// the request and `total_token_usage` the running total (a repeated total is the same request again).
// A forked session first copies its parent's history in a burst; with ids those copies dedupe, and
// without them the burst only sets the running total.

interface CodexUsage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}
function codexUsage(v: unknown): CodexUsage | null {
  const u = obj(v);
  if (!u || typeof u.input_tokens !== 'number' || typeof u.output_tokens !== 'number') return null;
  const r = { input: count(u.input_tokens), cached: count(u.cached_input_tokens), cacheWrite: count(u.cache_write_input_tokens), output: count(u.output_tokens), reasoning: count(u.reasoning_output_tokens) };
  return r.cached + r.cacheWrite <= r.input && r.reasoning <= r.output ? r : null;
}
const sameUsage = (a: CodexUsage, b: CodexUsage) => a.input === b.input && a.cached === b.cached && a.cacheWrite === b.cacheWrite && a.output === b.output && a.reasoning === b.reasoning;
const FORK_BURST_MS = 1000;
const CODEX_MARKERS = /"(session_meta|turn_context|token_usage_record|token_count|thread_settings_applied)"/;

export function codexText(text: string): UsageRec[] {
  const out: UsageRec[] = [];
  let model = '';
  let session = '';
  let speed: Speed = 'standard';
  let sawMeta = false;
  let copying = false;
  let anchor = 0;
  let ledger = false;
  let running: CodexUsage | null = null;
  let lastSig = '';
  const starts = new Set<string>();
  const rec = (ts: number, u: CodexUsage, key: string | null): UsageRec => ({
    ts,
    model,
    session,
    input: u.input - u.cached - u.cacheWrite,
    cacheRead: u.cached,
    cacheWrite: u.cacheWrite,
    cacheWrite1h: 0,
    output: u.output,
    reasoning: u.reasoning,
    speed,
    costUsd: null,
    key,
  });
  for (const line of text.split('\n')) {
    if (!CODEX_MARKERS.test(line)) continue;
    const o = parse(line);
    const p = obj(o?.payload);
    if (!o || !p) continue;
    const ts = isoMs(o.timestamp);
    if (o.type === 'session_meta') {
      // Only the first: later ones are copies of an ancestor's.
      if (sawMeta) continue;
      sawMeta = true;
      session = str(p.id) || str(p.session_id);
      const spawn = obj(obj(obj(p.source)?.subagent)?.thread_spawn);
      if (ts !== null && (typeof p.forked_from_id === 'string' || typeof spawn?.parent_thread_id === 'string')) {
        copying = true;
        anchor = ts;
      }
      continue;
    }
    if (o.type === 'turn_context') {
      ledger = false;
      if (str(p.model)) model = str(p.model);
      continue;
    }
    if (p.type === 'thread_settings_applied') {
      const tier = obj(p.thread_settings)?.service_tier;
      speed = tier === 'priority' || tier === 'fast' ? 'fast' : tier === 'ultrafast' ? 'ultrafast' : 'standard';
      continue;
    }
    if (ts === null || !model) continue;
    // Still inside a fork's copied burst?
    let copied = false;
    if (copying) {
      if (ts - anchor < FORK_BURST_MS) {
        anchor = ts;
        copied = true;
      } else copying = false;
    }
    if (o.type === 'token_usage_record') {
      const u = codexUsage(p.usage);
      const id = str(p.response_id);
      if (!u || u.input + u.output === 0) continue;
      ledger = true;
      // Copies carry the parent's ids, so they dedupe; without an id a copy can't be told apart.
      if (copied && !id) continue;
      out.push(rec(ts, u, id ? `codex:${id}` : null));
      continue;
    }
    if (p.type !== 'token_count') continue;
    const info = obj(p.info);
    if (!info) continue;
    const last = codexUsage(info.last_token_usage);
    const sum = info.total_token_usage == null ? null : codexUsage(info.total_token_usage);
    if (sum) {
      const prev = running;
      running = sum;
      // With request records, snapshots only keep the running total.
      if (ledger || copied) continue;
      // The same snapshot again.
      if (prev && sameUsage(sum, prev)) continue;
      // Counters that begin again at this request count it once; any other lower total is an older
      // snapshot replayed on resume.
      if (last !== null && sameUsage(sum, last)) {
        const sig = `${ts}|${JSON.stringify(last)}`;
        if (starts.has(sig)) continue;
        starts.add(sig);
      } else if (prev && (sum.input < prev.input || sum.output < prev.output)) continue;
    } else {
      const sig = JSON.stringify(last);
      if (ledger || copied || sig === lastSig) continue;
      lastSig = sig;
    }
    if (last && last.input + last.output > 0) out.push(rec(ts, last, null));
  }
  return out.filter((r) => total(r) > 0);
}

// ------------------------------------------------------------------ Grok Build
// ~/.grok/sessions/<session>/updates.jsonl: a `turn_completed` update per prompt, with usage split by
// model and its cost in ticks (10^10 per dollar).

const TICKS_PER_USD = 10_000_000_000;

export function grokLine(line: string): UsageRec[] {
  if (!line.includes('"turn_completed"')) return [];
  const o = parse(line);
  const params = obj(o?.params);
  const update = obj(params?.update);
  const usage = obj(update?.usage);
  if (!o || !params || update?.sessionUpdate !== 'turn_completed' || !usage) return [];
  const agentMs = obj(params._meta)?.agentTimestampMs;
  const ts = typeof agentMs === 'number' && Number.isFinite(agentMs) ? agentMs : typeof o.timestamp === 'number' && Number.isFinite(o.timestamp) ? (o.timestamp > 1e12 ? o.timestamp : o.timestamp * 1000) : null;
  if (ts === null) return [];
  const session = str(params.sessionId);
  const prompt = str(update.prompt_id);
  const one = (u: Obj, model: string): UsageRec => {
    const cacheRead = count(u.cachedReadTokens);
    const cacheWrite = count(u.cacheCreationTokens);
    const output = count(u.outputTokens);
    const ticks = money(u.costUsdTicks);
    return {
      ts,
      model,
      session,
      input: Math.max(0, count(u.inputTokens) - cacheRead - cacheWrite),
      cacheRead,
      cacheWrite,
      cacheWrite1h: 0,
      output,
      reasoning: Math.min(output, count(u.reasoningTokens)),
      speed: 'standard',
      costUsd: ticks === null ? null : ticks / TICKS_PER_USD,
      key: prompt ? `grok:${session}:${prompt}:${ts}:${model}` : null,
    };
  };
  const byModel = Object.entries(obj(usage.modelUsage) ?? {}).flatMap(([model, u]) => (model && obj(u) ? [one(obj(u)!, model)] : []));
  if (!byModel.length) return [one(usage, 'grok')].filter((r) => total(r) > 0);
  // Models without their own cost share what is left of the turn's.
  const turnCost = money(usage.costUsdTicks);
  const priced = byModel.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  const unpricedTokens = byModel.reduce((n, r) => n + (r.costUsd === null ? total(r) : 0), 0);
  for (const r of byModel)
    if (r.costUsd === null && turnCost !== null && unpricedTokens > 0) r.costUsd = Math.max(0, turnCost / TICKS_PER_USD - priced) * (total(r) / unpricedTokens);
  return byModel.filter((r) => total(r) > 0);
}

// ------------------------------------------------------------------ OpenCode
// ~/.local/share/opencode/opencode.db: assistant messages (table `message`, or `session_message` in
// OpenCode 2) hold `tokens`, `cost` and the model in their JSON. The query projects only those fields.
// A fork copies messages under new ids with the same time and data, so those identify a request.

export function openCodeRow(data: string, session: string, created: unknown): UsageRec | null {
  const m = parse(data);
  if (!m) return null;
  const t = obj(m.tokens);
  const cache = obj(t?.cache);
  const ref = obj(m.model);
  const model = str(ref?.id) || str(ref?.modelID) || str(m.modelID);
  const time = obj(m.time)?.created;
  const ts = typeof time === 'number' && Number.isFinite(time) ? time : typeof created === 'number' && Number.isFinite(created) ? created : null;
  if (!t || !model || ts === null) return null;
  const reasoning = count(t.reasoning);
  const r: UsageRec = {
    ts,
    model,
    session: str(m.sessionID) || session,
    input: count(t.input),
    cacheRead: count(cache?.read),
    cacheWrite: count(cache?.write),
    cacheWrite1h: 0,
    // OpenCode counts reasoning apart from output.
    output: count(t.output) + reasoning,
    reasoning,
    speed: 'standard',
    // A cost of 0 usually means "not reported" (subscriptions, unknown models).
    costUsd: typeof m.cost === 'number' && Number.isFinite(m.cost) && m.cost > 0 ? m.cost : null,
    key: `opencode:${ts}:${model}:${JSON.stringify(t)}`,
  };
  return total(r) > 0 ? r : null;
}

// ------------------------------------------------------------------ Antigravity
// ~/.gemini/antigravity*/conversations/<id>.db: SQLite with protobuf blobs. `steps.metadata` and
// `gen_metadata.data` carry usage (field numbers below); retries add more usage entries. The same
// request can appear as a step and as a generation; ids in the usage (fields 11, 12, 7) tie them.

type Field = number | Uint8Array;
type Fields = Map<number, Field[]>;

/** A protobuf message's fields by number. Throws on malformed input. */
export function protoFields(b: Uint8Array): Fields {
  const out: Fields = new Map();
  let i = 0;
  const varint = (): number => {
    let v = 0;
    let mul = 1;
    for (let n = 0; n < 10; n++) {
      const byte = b[i++];
      if (byte === undefined) throw new Error('truncated');
      v += (byte & 0x7f) * mul;
      if (byte < 0x80) return v;
      mul *= 128;
    }
    throw new Error('bad varint');
  };
  while (i < b.length) {
    const tag = varint();
    const num = Math.floor(tag / 8);
    const wire = tag % 8;
    if (num === 0) throw new Error('bad field');
    let val: Field;
    if (wire === 0) val = varint();
    else if (wire === 2) {
      const len = varint();
      if (len > b.length - i) throw new Error('truncated');
      val = b.subarray(i, i + len);
      i += len;
    } else if (wire === 1 || wire === 5) {
      i += wire === 1 ? 8 : 4;
      if (i > b.length) throw new Error('truncated');
      continue;
    } else throw new Error('bad wire type');
    const list = out.get(num) ?? [];
    list.push(val);
    out.set(num, list);
  }
  return out;
}
const pNum = (f: Fields, n: number) => {
  const v = f.get(n)?.[0];
  return typeof v === 'number' ? v : 0;
};
const pBytes = (f: Fields, n: number) => {
  const v = f.get(n)?.[0];
  return v instanceof Uint8Array ? v : undefined;
};
const pMsg = (f: Fields, n: number): Fields => {
  const b = pBytes(f, n);
  return b ? protoFields(b) : new Map();
};
const pText = (f: Fields, n: number) => {
  const b = pBytes(f, n);
  if (!b) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b).trim();
  } catch {
    return '';
  }
};
const pTime = (f: Fields) => {
  const s = pNum(f, 1);
  return s > 0 ? s * 1000 + Math.floor(pNum(f, 2) / 1e6) : null;
};

/** Model numbers seen in Antigravity's logs, for entries that carry no name. */
const AG_MODELS: Record<number, string> = {
  246: 'gemini-2.5-pro', 312: 'gemini-2.5-flash', 313: 'gemini-2.5-flash', 329: 'gemini-2.5-flash', 330: 'gemini-2.5-flash-lite',
  281: 'claude-sonnet-4', 282: 'claude-sonnet-4', 290: 'claude-opus-4', 291: 'claude-opus-4', 333: 'claude-sonnet-4-5', 334: 'claude-sonnet-4-5',
  340: 'claude-haiku-4-5', 341: 'claude-haiku-4-5', 342: 'gpt-oss-120b', 1026: 'claude-opus-4-6', 1035: 'claude-sonnet-4-6',
  1016: 'gemini-3.1-pro', 1036: 'gemini-3.1-pro', 1037: 'gemini-3.1-pro', 1018: 'gemini-3-flash-preview', 1084: 'gemini-3-flash-preview',
  1047: 'gemini-3-flash-preview', 1020: 'gemini-3.5-flash', 1021: 'gemini-3.1-flash-image', 1050: 'gemini-3.1-flash-lite',
  1071: 'gemini-3.6-flash', 1072: 'gemini-3.6-flash', 1073: 'gemini-3.6-flash', 1132: 'gemini-3.5-flash', 1133: 'gemini-3.5-flash',
  1187: 'gemini-3.5-flash', 1196: 'gemini-3.6-flash', 1266: 'gemini-3.6-flash', 1298: 'gemini-3.7-flash', 1299: 'gemini-3.7-flash',
  1300: 'gemini-3.7-flash', 1301: 'gemini-3.7-flash', 1318: 'gemini-3.8-flash', 1319: 'gemini-3.8-flash', 1320: 'gemini-3.8-flash',
  1322: 'gemini-3.8-flash', 1402: 'claude-opus-5-5', 1417: 'gemini-4-argon', 1418: 'gemini-4-argon', 1419: 'gemini-4-argon',
  1537: 'gemini-4-neon',
};

/** Display names such as "Claude 4.5 Sonnet (Thinking)" or "Gemini 3.1 Pro (High)" as the price list names them. */
export function agModelName(name: string): string {
  if (!name) return '';
  let n = name.toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').trim().replace(/\s+/g, '-');
  if (n.startsWith('claude-')) n = n.replace(/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)/, 'claude-$2-$1').replaceAll('.', '-');
  // Effort and routing variants share the base model's price.
  return n.replace(/-(?:extra-low|low|medium|high|tiered|thinking|agent|orchestrator)$/, '');
}
const concrete = (m: string) => /^(?:gemini-\d|claude-(?:sonnet|opus|haiku)-\d|gpt-)/.test(m);

export interface AgEntry {
  model: string;
  modelId: number;
  ts: number | null;
  usages: Fields[];
}

/** One `steps.metadata` (step) or `gen_metadata.data` (generation) blob. */
export function agMetadata(blob: Uint8Array, step: boolean): AgEntry {
  const root = protoFields(blob);
  const data = step ? root : pMsg(root, 1);
  const model = step ? pMsg(data, 24) : data;
  const main = pBytes(data, step ? 9 : 4);
  const usages = main ? [protoFields(main)] : [];
  for (const retry of data.get(step ? 28 : 17) ?? []) {
    if (!(retry instanceof Uint8Array)) continue;
    const u = pBytes(protoFields(retry), 2);
    if (u) usages.push(protoFields(u));
  }
  const names = [pText(model, step ? 12 : 19), pText(model, step ? 8 : 21)].map(agModelName);
  return {
    model: names.find(concrete) ?? names.find((n) => n && !/^model[_-]/.test(n)) ?? '',
    modelId: pNum(model, step ? 1 : 3) || (usages[0] ? pNum(usages[0], 1) : 0),
    ts: step ? (pTime(pMsg(data, 8)) ?? pTime(pMsg(data, 1))) : pTime(pMsg(pMsg(data, 9), 4)),
    usages,
  };
}

/** Usage records of one conversation, given its steps and generations (each in `idx` order). */
export function agRecords(session: string, steps: (AgEntry & { idx: number })[], generations: (AgEntry & { idx: number })[], fallbackTs: number, names: Map<number, string>): UsageRec[] {
  const genByIdx = new Map(generations.map((g) => [g.idx, g]));
  const out: UsageRec[] = [];
  const seen = new Map<string, UsageRec>();
  const both: [string, (AgEntry & { idx: number })[]][] = [
    ['step', steps],
    ['gen', generations],
  ];
  for (const [kind, entries] of both) {
    entries.forEach((e, i) => {
      e.usages.forEach((u, j) => {
        const modelId = pNum(u, 1) || e.modelId;
        const matches = (x: AgEntry) => modelId === 0 || x.modelId === modelId;
        const gen = kind === 'step' ? genByIdx.get(e.idx) : undefined;
        const named = matches(e) && e.model ? e.model : gen && matches(gen) ? gen.model : '';
        const model = named || names.get(modelId) || AG_MODELS[modelId] || 'antigravity';
        const output = Math.max(pNum(u, 3), pNum(u, 9) + pNum(u, 10));
        const r: UsageRec = {
          ts: e.ts ?? fallbackTs,
          model,
          session,
          input: pNum(u, 2),
          cacheRead: pNum(u, 5),
          cacheWrite: pNum(u, 4),
          cacheWrite1h: 0,
          output,
          reasoning: Math.min(output, pNum(u, 9)),
          speed: 'standard',
          costUsd: null,
          key: null,
        };
        if (total(r) === 0) return;
        const ids = [11, 12, 7].map((n) => pText(u, n)).filter(Boolean).map((id) => `antigravity:${id}`);
        const dup = ids.map((id) => seen.get(id)).find(Boolean);
        if (dup) {
          mergeInto(dup, r);
          if (dup.model === 'antigravity' || (!concrete(dup.model) && concrete(r.model))) dup.model = r.model;
        } else {
          r.key = ids[0] ?? `antigravity:${session}:${kind}:${i}:${j}`;
          out.push(r);
        }
        for (const id of ids) seen.set(id, dup ?? r);
      });
    });
  }
  return out;
}

/** The same request logged twice: keep the larger count of each kind (one may be a partial). */
export function mergeInto(a: UsageRec, b: UsageRec) {
  a.input = Math.max(a.input, b.input);
  a.cacheRead = Math.max(a.cacheRead, b.cacheRead);
  a.cacheWrite = Math.max(a.cacheWrite, b.cacheWrite);
  a.cacheWrite1h = Math.max(a.cacheWrite1h, b.cacheWrite1h);
  a.output = Math.max(a.output, b.output);
  a.reasoning = Math.max(a.reasoning, b.reasoning);
  if (a.costUsd === null) a.costUsd = b.costUsd;
  else if (b.costUsd !== null) a.costUsd = Math.max(a.costUsd, b.costUsd);
}
