// Finds the other AI apps' logs on this computer, reads the usage in them (parse.ts) and sums it by day,
// app and model. Runs in a worker (worker.ts): the first read of a few GB takes seconds. What was read is
// cached per file (size and modification time), so later reads only open files that changed.

import { createReadStream, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { zstdDecompressSync } from 'node:zlib';
import { agMetadata, agRecords, claudeLine, codexText, grokLine, mergeInto, openCodeRow, total, type AgEntry, type AppId, type Speed, type UsageRec } from './parse';

export const APPS: AppId[] = ['claude-code', 'codex', 'grok-build', 'antigravity', 'opencode'];
export const WINDOW_DAYS = 90;
/** Prompt sizes past which some models charge more: every `above_<n>k_tokens` tier in the price list. */
export const PROMPT_TIERS = [32_000, 100_000, 128_000, 200_000, 256_000, 272_000, 512_000];
/** Codex files are read whole; anything bigger than this isn't a rollout. */
const MAX_TEXT = 768 * 1024 * 1024;
const CACHE_VERSION = 2;

export interface ScanInput {
  home: string;
  dataDir: string;
  /** CLAUDE_CONFIG_DIR, CODEX_HOME, GROK_HOME, XDG_DATA_HOME when set. */
  env: Record<string, string | undefined>;
  now: number;
}

/** day × app × model × speed × prompt tier, summed. */
export interface LocalUsageRow {
  day: string;
  app: AppId;
  model: string;
  speed: Speed;
  /** The largest of PROMPT_TIERS the requests' prompts were over (0: none). */
  tier: number;
  requests: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
  /** The cost the app recorded for all of these requests, or null when it didn't. */
  costUsd: number | null;
}

export interface LocalUsageReport {
  version: 1;
  generatedAt: number;
  /** Calendar days on this computer, oldest first; the last is today. */
  days: string[];
  apps: { id: AppId; found: boolean; files: number; unreadable: number }[];
  rows: LocalUsageRow[];
  /** One entry per session: its app and the last day it used a model. */
  sessions: [AppId, string][];
  /** Seconds the read took (most of it the first time). */
  seconds: number;
}

// ------------------------------------------------------------------ where each app keeps its logs

interface Source {
  app: AppId;
  /** Folders to walk. */
  roots: string[];
  /** Which files under them hold usage. */
  match: (name: string) => boolean;
  kind: 'lines' | 'codex' | 'opencode' | 'antigravity';
}

function sources({ home, env }: ScanInput): Source[] {
  const xdgData = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share');
  const claudeHomes = (env.CLAUDE_CONFIG_DIR?.trim() || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [
    { app: 'claude-code', roots: [...claudeHomes, join(home, '.claude'), join(home, '.config', 'claude')].map((d) => join(d, 'projects')), match: (n) => n.endsWith('.jsonl'), kind: 'lines' },
    { app: 'codex', roots: [env.CODEX_HOME?.trim() || join(home, '.codex')].flatMap((d) => [join(d, 'sessions'), join(d, 'archived_sessions')]), match: (n) => n.endsWith('.jsonl') || n.endsWith('.jsonl.zst'), kind: 'codex' },
    { app: 'grok-build', roots: [join(env.GROK_HOME?.trim() || join(home, '.grok'), 'sessions')], match: (n) => n === 'updates.jsonl', kind: 'lines' },
    { app: 'antigravity', roots: ['antigravity', 'antigravity-cli', 'antigravity-ide', 'antigravity-backup'].map((d) => join(home, '.gemini', d, 'conversations')), match: (n) => n.endsWith('.db'), kind: 'antigravity' },
    { app: 'opencode', roots: [join(xdgData, 'opencode')], match: (n) => n === 'opencode.db', kind: 'opencode' },
  ];
}

/** Files under `root` whose names match, without following links (a link could lead anywhere). */
async function walk(root: string, match: (n: string) => boolean, depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, match, depth + 1)));
    else if (e.isFile() && match(e.name)) out.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ reading one file

/** A record as cached: [ts, model, session, input, cacheRead, cacheWrite, cacheWrite1h, output, reasoning, speed, costUsd, key]. */
type Packed = [number, string, string, number, number, number, number, number, number, Speed, number | null, string | null];
const pack = (r: UsageRec): Packed => [r.ts, r.model, r.session, r.input, r.cacheRead, r.cacheWrite, r.cacheWrite1h, r.output, r.reasoning, r.speed, r.costUsd, r.key];
const unpack = (p: Packed): UsageRec => ({ ts: p[0], model: p[1], session: p[2], input: p[3], cacheRead: p[4], cacheWrite: p[5], cacheWrite1h: p[6], output: p[7], reasoning: p[8], speed: p[9], costUsd: p[10], key: p[11] });

async function readLines(path: string, parseLine: (l: string) => UsageRec[]): Promise<UsageRec[]> {
  const out: UsageRec[] = [];
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) for (const r of parseLine(line)) out.push(r);
  return out;
}

function readCodex(path: string): UsageRec[] {
  const raw = readFileSync(path);
  const text = path.endsWith('.zst') ? zstdDecompressSync(raw, { maxOutputLength: MAX_TEXT }) : raw;
  return codexText(text.toString('utf8'));
}

type Sqlite = { prepare(sql: string): { all(...p: unknown[]): Record<string, unknown>[] }; exec(sql: string): void; close(): void };
function openDb(path: string): Sqlite {
  // node:sqlite is loaded only here, so a Node without it fails just these two apps.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: string, o: { readOnly: boolean }) => Sqlite };
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 200');
  return db;
}
const tablesOf = (db: Sqlite) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name)));

/** Only the message tables, and only the usage fields of each message (never its text). */
function readOpenCode(path: string, since: number): UsageRec[] {
  const db = openDb(path);
  try {
    const tables = tablesOf(db);
    const out: UsageRec[] = [];
    for (const table of ['message', 'session_message']) {
      if (!tables.has(table)) continue;
      const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name)));
      if (!cols.has('data')) continue;
      const created = cols.has('time_created') ? 'time_created' : 'NULL';
      const where = [table === 'session_message' && cols.has('type') ? "type IN ('assistant', 'compaction')" : '', created !== 'NULL' ? `${created} >= ?` : '', "typeof(data) = 'text' AND json_valid(data)", "(json_type(data, '$.role') IS NULL OR data ->> '$.role' = 'assistant')"].filter(Boolean);
      const rows = db
        .prepare(
          `SELECT ${cols.has('session_id') ? 'session_id' : "''"} AS session, ${created} AS created, json_object('tokens', data -> '$.tokens', 'cost', data -> '$.cost', 'model', data -> '$.model', 'modelID', data -> '$.modelID', 'time', data -> '$.time', 'sessionID', data -> '$.sessionID') AS usage FROM ${table} WHERE ${where.join(' AND ')}`,
        )
        .all(...(created !== 'NULL' ? [since] : []));
      for (const row of rows) {
        const r = openCodeRow(String(row.usage), String(row.session ?? ''), row.created);
        if (r) out.push(r);
      }
    }
    return out;
  } finally {
    db.close();
  }
}

function readAntigravity(path: string, fileMtime: number, names: Map<number, string>): UsageRec[] {
  const db = openDb(path);
  try {
    const tables = tablesOf(db);
    if (!tables.has('steps') && !tables.has('gen_metadata')) return [];
    const read = (sql: string, step: boolean) => {
      const out: (AgEntry & { idx: number })[] = [];
      for (const row of db.prepare(sql).all()) {
        if (!(row.data instanceof Uint8Array) || typeof row.idx !== 'number') continue;
        try {
          out.push({ ...agMetadata(row.data, step), idx: row.idx });
        } catch {
          /* a blob we can't read: skip it */
        }
      }
      return out.sort((a, b) => a.idx - b.idx);
    };
    const gens = tables.has('gen_metadata') ? read('SELECT idx, data FROM gen_metadata', false) : [];
    const steps = tables.has('steps') ? read('SELECT idx, metadata AS data FROM steps WHERE metadata IS NOT NULL', true) : [];
    // Names learned here help entries elsewhere that carry only a model number.
    for (const e of [...gens, ...steps]) if (e.modelId > 0 && /^(?:gemini-\d|claude-|gpt-)/.test(e.model)) names.set(e.modelId, e.model);
    const session = path.replace(/^.*[\\/]/, '').replace(/\.db$/, '');
    return agRecords(session, steps, gens, fileMtime, names);
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ the cache

interface CachedFile {
  /** Size and modification time (plus the write-ahead log's, for databases) when read. */
  stamp: string;
  recs: Packed[];
}
interface Cache {
  v: number;
  files: Record<string, CachedFile>;
}
const cachePath = (dataDir: string) => join(dataDir, 'local-usage.json');

function loadCache(dataDir: string): Cache {
  try {
    const c = JSON.parse(readFileSync(cachePath(dataDir), 'utf8')) as Cache;
    if (c?.v === CACHE_VERSION && c.files && typeof c.files === 'object') return c;
  } catch {
    /* none yet, or unreadable: read everything again */
  }
  return { v: CACHE_VERSION, files: {} };
}
function saveCache(dataDir: string, c: Cache) {
  const p = cachePath(dataDir);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
  renameSync(tmp, p);
}
function stampOf(path: string, db: boolean): string | null {
  try {
    const s = statSync(path);
    let stamp = `${s.size}:${s.mtimeMs}`;
    if (db) {
      // New rows sit in the write-ahead log until SQLite folds them into the file.
      try {
        const w = statSync(`${path}-wal`);
        stamp += `|${w.size}:${w.mtimeMs}`;
      } catch {
        /* no log */
      }
    }
    return stamp;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the scan

/** This computer's calendar day of a time. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function windowStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (WINDOW_DAYS - 1));
  return d.getTime();
}
export function tierOf(r: UsageRec): number {
  const prompt = r.input + r.cacheRead + r.cacheWrite;
  let t = 0;
  for (const x of PROMPT_TIERS) if (prompt > x) t = x;
  return t;
}

export async function scan(input: ScanInput): Promise<LocalUsageReport> {
  const started = Date.now();
  const since = windowStart(input.now);
  const cache = loadCache(input.dataDir);
  const next: Cache = { v: CACHE_VERSION, files: {} };
  const apps: LocalUsageReport['apps'] = [];
  const byApp = new Map<AppId, UsageRec[]>();
  const agNames = new Map<number, string>();

  for (const src of sources(input)) {
    const seenRoots = new Set<string>();
    let found = false;
    let files = 0;
    let unreadable = 0;
    const recs: UsageRec[] = [];
    for (const root of src.roots) {
      let real: string;
      try {
        // A linked root (dotfiles kept elsewhere) is fine; reading the same folder twice isn't.
        real = realpathSync(root);
      } catch {
        continue;
      }
      if (seenRoots.has(real)) continue;
      seenRoots.add(real);
      found = true;
      for (const path of await walk(real, src.match)) {
        const db = src.kind === 'opencode' || src.kind === 'antigravity';
        const stamp = stampOf(path, db);
        if (stamp === null) continue;
        // Untouched since before the window: nothing in it can count.
        if (Number(stamp.split('|')[0].split(':')[1]) < since) continue;
        files++;
        const key = `${src.app}\0${path}`;
        const hit = cache.files[key];
        let got: UsageRec[];
        if (hit && hit.stamp === stamp) got = hit.recs.map(unpack);
        else {
          try {
            got =
              src.kind === 'codex'
                ? readCodex(path)
                : src.kind === 'opencode'
                  ? readOpenCode(path, since)
                  : src.kind === 'antigravity'
                    ? readAntigravity(path, Number(stamp.split('|')[0].split(':')[1]), agNames)
                    : await readLines(path, src.app === 'claude-code' ? claudeLine : grokLine);
          } catch {
            unreadable++;
            continue;
          }
        }
        got = got.filter((r) => r.ts >= since);
        next.files[key] = { stamp, recs: got.map(pack) };
        recs.push(...got);
      }
    }
    apps.push({ id: src.app, found, files, unreadable });
    byApp.set(src.app, recs);
  }
  try {
    saveCache(input.dataDir, next);
  } catch {
    /* the next read just starts over */
  }

  // The same request seen twice (content blocks, copied history) counts once.
  const rows = new Map<string, LocalUsageRow>();
  const sessions = new Map<string, [AppId, string]>();
  for (const [app, recs] of byApp) {
    const byKey = new Map<string, UsageRec>();
    const unique: UsageRec[] = [];
    for (const r of recs) {
      if (r.key === null) unique.push(r);
      else {
        const had = byKey.get(r.key);
        if (had) mergeInto(had, r);
        else {
          const copy = { ...r };
          byKey.set(r.key, copy);
          unique.push(copy);
        }
      }
    }
    for (const r of unique) {
      if (total(r) === 0) continue;
      const day = localDay(r.ts);
      const tier = tierOf(r);
      const reported = r.costUsd !== null;
      const k = `${day}\0${app}\0${r.model}\0${r.speed}\0${tier}\0${reported}`;
      let row = rows.get(k);
      if (!row) rows.set(k, (row = { day, app, model: r.model, speed: r.speed, tier, requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, costUsd: reported ? 0 : null }));
      row.requests++;
      row.input += r.input;
      row.cacheRead += r.cacheRead;
      row.cacheWrite += r.cacheWrite;
      row.cacheWrite1h += r.cacheWrite1h;
      row.output += r.output;
      row.reasoning += r.reasoning;
      if (row.costUsd !== null) row.costUsd += r.costUsd ?? 0;
      if (r.session) {
        const sk = `${app}\0${r.session}`;
        const s = sessions.get(sk);
        if (!s || s[1] < day) sessions.set(sk, [app, day]);
      }
    }
  }
  const days: string[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const d = new Date(since);
    d.setDate(d.getDate() + i);
    days.push(localDay(d.getTime()));
  }
  return { version: 1, generatedAt: input.now, days, apps, rows: [...rows.values()], sessions: [...sessions.values()], seconds: Math.round((Date.now() - started) / 100) / 10 };
}

