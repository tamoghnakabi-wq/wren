// Model prices for estimating what local usage would cost at API rates (Usage → This Mac). Built from
// LiteLLM's public price list by /api/usage/prices; priced in the browser, so usage never leaves the
// computer. Prices are dollars per token.

export interface Rates {
  /** Input not read from or written to the prompt cache. */
  i: number;
  o: number;
  /** Cache reads, cache writes, and cache writes kept for an hour. */
  cr: number;
  cw: number;
  cw1h: number;
}
export interface ModelPrice extends Rates {
  /** OpenAI's priority tier (and Codex "fast"); ultrafast. Missing: the standard price. */
  fast?: Rates;
  ultra?: Rates;
  /** Prompts over `above` tokens bill every token at these rates. Highest first. */
  tiers?: { above: number; rates: Rates; fast?: Rates; ultra?: Rates }[];
}
export type PriceTable = Record<string, ModelPrice>;

export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
/** Model makers' own APIs: their price beats a cloud's or a reseller's for a bare model name. */
const FIRST_PARTY = new Set(['anthropic', 'openai', 'xai', 'gemini', 'deepseek', 'mistral', 'moonshot', 'zai']);

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

function rates(e: Record<string, unknown>, suffix: string, base?: Rates): Rates | null {
  const i = num(e[`input_cost_per_token${suffix}`]);
  const o = num(e[`output_cost_per_token${suffix}`]) ?? base?.o ?? null;
  if (i === null || o === null) return null;
  const cache = (name: string, fallback: number) => num(e[`${name}${suffix}`]) ?? fallback;
  const cr = cache('cache_read_input_token_cost', base ? base.cr * (i / (base.i || i || 1)) : i);
  const cw = cache('cache_creation_input_token_cost', base ? base.cw * (i / (base.i || i || 1)) : i);
  const cw1h = num(e[suffix ? `cache_creation_input_token_cost_above_1hr${suffix}` : 'cache_creation_input_token_cost_above_1hr']) ?? (base ? base.cw1h * (i / (base.i || i || 1)) : cw);
  return { i, o, cr, cw, cw1h };
}

/** One LiteLLM entry as a ModelPrice, or null without input and output prices. */
export function priceOf(e: Record<string, unknown>): ModelPrice | null {
  const std = rates(e, '');
  if (!std) return null;
  const p: ModelPrice = { ...std };
  const fast = rates(e, '_priority', std);
  const ultra = rates(e, '_ultrafast', std);
  if (fast) p.fast = fast;
  if (ultra) p.ultra = ultra;
  const tiers: NonNullable<ModelPrice['tiers']> = [];
  for (const k of Object.keys(e)) {
    const m = /^input_cost_per_token_above_(\d{1,7})k_tokens$/.exec(k);
    if (!m) continue;
    const s = `_above_${m[1]}k_tokens`;
    const r = rates(e, s, std);
    if (!r) continue;
    const t: NonNullable<ModelPrice['tiers']>[number] = { above: Number(m[1]) * 1000, rates: r };
    const tf = rates(e, `${s}_priority`, r);
    const tu = rates(e, `${s}_ultrafast`, r);
    if (tf) t.fast = tf;
    if (tu) t.ultra = tu;
    tiers.push(t);
  }
  if (tiers.length) p.tiers = tiers.sort((a, b) => b.above - a.above);
  return p;
}

/** The price table from LiteLLM's document: bare model names, first-party prices preferred. */
export function buildPriceTable(doc: unknown): PriceTable {
  const out: PriceTable = {};
  if (typeof doc !== 'object' || doc === null) return out;
  const aliases: [string, ModelPrice][] = [];
  for (const [name, raw] of Object.entries(doc as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || name === 'sample_spec') continue;
    const key = name.trim().toLowerCase();
    const slash = key.indexOf('/');
    if (slash !== -1 && !FIRST_PARTY.has(key.slice(0, slash))) continue;
    const p = priceOf(raw as Record<string, unknown>);
    if (!p) continue;
    if (slash === -1) out[key] = p;
    else aliases.push([key.slice(key.lastIndexOf('/') + 1), p]);
  }
  for (const [bare, p] of aliases) if (!(bare in out)) out[bare] = p;
  return out;
}

/** A model name as logged, matched to the table: exact, then without a date or variant suffix. */
export function lookupPrice(table: PriceTable, model: string): ModelPrice | null {
  let k = model.trim().toLowerCase().replace(/\[.*$/, '');
  k = k.slice(k.lastIndexOf('/') + 1);
  if (!k || ['synthetic', '<synthetic>', 'opus', 'sonnet', 'haiku', 'fable', 'grok', 'antigravity'].includes(k)) return null;
  if (table[k]) return table[k];
  const dashed = k.startsWith('claude-') ? k.replaceAll('.', '-') : k;
  if (table[dashed]) return table[dashed];
  // "claude-opus-4-5-20251101", "gemini-4-argon-trial", "gemini-3.8-flash-n": drop trailing parts while
  // what is left still names a version.
  let cut = dashed;
  for (let n = 0; n < 2; n++) {
    const i = cut.lastIndexOf('-');
    if (i <= 0) break;
    cut = cut.slice(0, i);
    if (!/\d/.test(cut)) break;
    if (table[cut]) return table[cut];
  }
  return null;
}

/** One summed slice of usage, as the desktop app reports it. */
export interface PricedUsage {
  model: string;
  speed: 'standard' | 'fast' | 'ultrafast';
  /** The largest prompt size its requests were over (0: none). */
  tier: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  /** What the app itself recorded, if it did. */
  costUsd: number | null;
}

/** Its estimated cost in dollars, or null when the model has no price. Free models cost 0. */
export function estimateCost(table: PriceTable | null, u: PricedUsage): number | null {
  if (u.costUsd !== null) return u.costUsd;
  if (/(^|[-:/])free$/i.test(u.model)) return 0;
  if (!table) return null;
  const p = lookupPrice(table, u.model);
  if (!p) return null;
  const tier = p.tiers?.find((t) => u.tier >= t.above);
  const base = tier?.rates ?? p;
  const r = u.speed === 'fast' ? (tier?.fast ?? p.fast ?? base) : u.speed === 'ultrafast' ? (tier?.ultra ?? p.ultra ?? base) : base;
  const hour = Math.min(u.cacheWrite1h, u.cacheWrite);
  return u.input * r.i + u.cacheRead * r.cr + (u.cacheWrite - hour) * r.cw + hour * r.cw1h + u.output * r.o;
}

/** What reading from the cache saved against paying full input price, or null without a price. */
export function cacheSavings(table: PriceTable | null, u: PricedUsage): number | null {
  if (!table || u.costUsd !== null) return null;
  const p = lookupPrice(table, u.model);
  if (!p) return null;
  const tier = p.tiers?.find((t) => u.tier >= t.above);
  const r = tier?.rates ?? p;
  return u.cacheRead * Math.max(0, r.i - r.cr);
}
