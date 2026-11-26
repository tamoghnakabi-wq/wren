// Usage → This Mac: sums the desktop's local usage report (lib/client/desktop.ts) over the chosen days
// and prices it with the model price table (lib/model-prices.ts). Pure, so it is tested on its own.

import type { LocalApp, LocalUsageReport, LocalUsageRow } from './client/desktop';
import { cacheSavings, estimateCost, type PriceTable } from './model-prices';

/** In order of the list on the page. */
export const LOCAL_APPS: { id: LocalApp; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'grok-build', label: 'Grok Build' },
  { id: 'opencode', label: 'OpenCode' },
];
export const appLabel = (id: LocalApp) => LOCAL_APPS.find((a) => a.id === id)?.label ?? id;

export const tokensOf = (r: Pick<LocalUsageRow, 'input' | 'cacheRead' | 'cacheWrite' | 'output'>) => r.input + r.cacheRead + r.cacheWrite + r.output;

/** Tokens and estimated cost. `cost` covers only priced tokens; `unpriced` counts the rest. */
export interface Amount {
  tokens: number;
  cost: number;
  unpriced: number;
}
const zero = (): Amount => ({ tokens: 0, cost: 0, unpriced: 0 });

export interface LocalSummary {
  days: string[];
  total: Amount & { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; requests: number; sessions: number; savings: number };
  /** Every app, found or not, busiest first. */
  apps: (Amount & { id: LocalApp; label: string; found: boolean; sessions: number })[];
  /** One entry per day of the range, oldest first. */
  daily: { day: string; total: Amount; apps: Partial<Record<LocalApp, Amount>> }[];
  models: (Amount & { model: string; app: LocalApp; requests: number })[];
  /** Models seen without a price (shown as tokens only). */
  unpricedModels: string[];
}

function add(a: Amount, tokens: number, cost: number | null) {
  a.tokens += tokens;
  if (cost === null) a.unpriced += tokens;
  else a.cost += cost;
}

/** The last `days` days of the report (today included), priced with `prices` (null: tokens only). */
export function summarize(report: LocalUsageReport, days: number, prices: PriceTable | null): LocalSummary {
  const range = report.days.slice(-days);
  const from = range[0] ?? '';
  const total = { ...zero(), input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, requests: 0, sessions: 0, savings: 0 };
  const apps = new Map(report.apps.map((a) => [a.id, { ...zero(), id: a.id, label: appLabel(a.id), found: a.found, sessions: 0 }]));
  for (const { id, label } of LOCAL_APPS) if (!apps.has(id)) apps.set(id, { ...zero(), id, label, found: false, sessions: 0 });
  const daily = new Map(range.map((day) => [day, { day, total: zero(), apps: {} as Partial<Record<LocalApp, Amount>> }]));
  const models = new Map<string, LocalSummary['models'][number]>();
  const unpriced = new Set<string>();
  for (const r of report.rows) {
    const d = daily.get(r.day);
    if (!d) continue;
    const tokens = tokensOf(r);
    const cost = estimateCost(prices, r);
    if (cost === null) unpriced.add(r.model);
    add(total, tokens, cost);
    total.input += r.input;
    total.cacheRead += r.cacheRead;
    total.cacheWrite += r.cacheWrite;
    total.output += r.output;
    total.reasoning += r.reasoning;
    total.requests += r.requests;
    total.savings += cacheSavings(prices, r) ?? 0;
    const app = apps.get(r.app);
    if (app) add(app, tokens, cost);
    add(d.total, tokens, cost);
    add((d.apps[r.app] ??= zero()), tokens, cost);
    const mk = `${r.app}\0${r.model}`;
    let m = models.get(mk);
    if (!m) models.set(mk, (m = { ...zero(), model: r.model, app: r.app, requests: 0 }));
    add(m, tokens, cost);
    m.requests += r.requests;
  }
  for (const [app, last] of report.sessions) {
    if (last < from) continue;
    total.sessions++;
    const a = apps.get(app);
    if (a) a.sessions++;
  }
  return {
    days: range,
    total,
    apps: [...apps.values()].sort((a, b) => b.tokens - a.tokens || Number(b.found) - Number(a.found) || LOCAL_APPS.findIndex((x) => x.id === a.id) - LOCAL_APPS.findIndex((x) => x.id === b.id)),
    daily: [...daily.values()],
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens),
    unpricedModels: [...unpriced],
  };
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
