import { describe, expect, it } from 'vitest';
import type { LocalUsageReport, LocalUsageRow } from '../src/lib/client/desktop';
import { summarize } from '../src/lib/local-usage';
import { buildPriceTable, cacheSavings, estimateCost, lookupPrice } from '../src/lib/model-prices';

// Usage → This Mac (desktop 0.1.53): local usage priced in the browser with LiteLLM's price list.

const M = 1e-6; // a dollar per million tokens, per token
const litellm = {
  sample_spec: { input_cost_per_token: 1, output_cost_per_token: 1 },
  'claude-opus-5-5': { litellm_provider: 'anthropic', input_cost_per_token: 4 * M, output_cost_per_token: 20 * M, cache_read_input_token_cost: 0.2 * M, cache_creation_input_token_cost: 5 * M, cache_creation_input_token_cost_above_1hr: 8 * M },
  'azure_ai/claude-opus-5-5': { input_cost_per_token: 9 * M, output_cost_per_token: 9 * M },
  'gpt-6.1-sol': { input_cost_per_token: 2 * M, output_cost_per_token: 10 * M, cache_read_input_token_cost: 0.1 * M, input_cost_per_token_priority: 4 * M, output_cost_per_token_priority: 20 * M, input_cost_per_token_above_272k_tokens: 4 * M, output_cost_per_token_above_272k_tokens: 15 * M, cache_read_input_token_cost_above_272k_tokens: 0.2 * M },
  'xai/grok-4.7': { input_cost_per_token: 2 * M, output_cost_per_token: 6 * M, cache_read_input_token_cost: 0.5 * M },
  'kyma/grok-build': { input_cost_per_token: 1 * M, output_cost_per_token: 2 * M },
  'gemini/gemini-4-argon': { input_cost_per_token: 2 * M, output_cost_per_token: 10 * M, cache_read_input_token_cost: 0.1 * M },
  'no-output-price': { input_cost_per_token: 1 * M },
};
const table = buildPriceTable(litellm);

describe('the price table', () => {
  it('keeps bare names and first-party prices, not resellers', () => {
    expect(Object.keys(table).sort()).toEqual(['claude-opus-5-5', 'gemini-4-argon', 'gpt-6.1-sol', 'grok-4.7']);
    expect(table['claude-opus-5-5'].i).toBeCloseTo(4 * M);
    expect(table['claude-opus-5-5'].cw1h).toBeCloseTo(8 * M);
    expect(table['gpt-6.1-sol'].tiers?.[0].above).toBe(272_000);
    expect(table['gpt-6.1-sol'].fast?.o).toBeCloseTo(20 * M);
  });

  it('matches logged names with dates, variants and suffixes', () => {
    expect(lookupPrice(table, 'claude-opus-5-5-20261001')).toBe(table['claude-opus-5-5']);
    expect(lookupPrice(table, 'claude-opus-5-5[1m]')).toBe(table['claude-opus-5-5']);
    expect(lookupPrice(table, 'gemini-4-argon-trial')).toBe(table['gemini-4-argon']);
    expect(lookupPrice(table, 'openai/gpt-6.1-sol')).toBe(table['gpt-6.1-sol']);
    expect(lookupPrice(table, 'codex-auto-review')).toBeNull();
    expect(lookupPrice(table, 'opus')).toBeNull();
  });
});

const row = (o: Partial<LocalUsageRow> = {}): LocalUsageRow => ({ day: '2026-11-26', app: 'claude-code', model: 'claude-opus-5-5', speed: 'standard', tier: 0, requests: 1, input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, costUsd: null, ...o });

describe('estimated cost', () => {
  it('prices each kind of token, with hour-long cache writes at their own rate', () => {
    const c = estimateCost(table, row({ input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, cacheWrite1h: 0.5e6, output: 1e6 }));
    expect(c).toBeCloseTo(4 + 0.2 + 2.5 + 4 + 20);
  });

  it('uses long-prompt and priority prices', () => {
    expect(estimateCost(table, row({ model: 'gpt-6.1-sol', tier: 272_000, input: 1e6, output: 1e6 }))).toBeCloseTo(4 + 15);
    expect(estimateCost(table, row({ model: 'gpt-6.1-sol', tier: 200_000, input: 1e6, output: 1e6 }))).toBeCloseTo(2 + 10);
    expect(estimateCost(table, row({ model: 'gpt-6.1-sol', speed: 'fast', input: 1e6, output: 1e6 }))).toBeCloseTo(4 + 20);
    // No ultrafast price: the standard one.
    expect(estimateCost(table, row({ model: 'gpt-6.1-sol', speed: 'ultrafast', input: 1e6 }))).toBeCloseTo(2);
  });

  it('keeps the app’s own cost, prices free models at 0 and unknown ones at nothing', () => {
    expect(estimateCost(table, row({ costUsd: 1.25, input: 1e9 }))).toBe(1.25);
    expect(estimateCost(table, row({ model: 'muse-spark-1.3-contributor-free', input: 1e6 }))).toBe(0);
    expect(estimateCost(table, row({ model: 'codex-auto-review', input: 1e6 }))).toBeNull();
    expect(estimateCost(null, row({ input: 1e6 }))).toBeNull();
  });

  it('works out what the cache saved', () => {
    expect(cacheSavings(table, row({ cacheRead: 1e6 }))).toBeCloseTo(3.8);
  });
});

describe('the summary for a range', () => {
  const report: LocalUsageReport = {
    version: 1,
    generatedAt: 0,
    days: ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'],
    apps: [
      { id: 'claude-code', found: true, files: 2, unreadable: 0 },
      { id: 'codex', found: true, files: 1, unreadable: 0 },
      { id: 'opencode', found: false, files: 0, unreadable: 0 },
    ],
    rows: [
      row({ day: '2026-11-20', input: 1e6 }),
      row({ day: '2026-11-26', input: 2e6, requests: 3 }),
      row({ day: '2026-11-26', app: 'codex', model: 'codex-auto-review', input: 1e6 }),
    ],
    sessions: [
      ['claude-code', '2026-11-20'],
      ['claude-code', '2026-11-26'],
      ['codex', '2026-11-26'],
    ],
    seconds: 1,
  };

  it('counts only the chosen days, with sessions active in them', () => {
    const s = summarize(report, 3, table);
    expect(s.days).toEqual(['2026-11-24', '2026-11-25', '2026-11-26']);
    expect(s.total.tokens).toBe(3e6);
    expect(s.total.sessions).toBe(2);
    expect(s.total.cost).toBeCloseTo(8);
    expect(s.total.unpriced).toBe(1e6);
    expect(s.unpricedModels).toEqual(['codex-auto-review']);
    expect(s.apps.map((a) => [a.id, a.tokens, a.found, a.sessions])).toEqual([
      ['claude-code', 2e6, true, 1],
      ['codex', 1e6, true, 1],
      ['antigravity', 0, false, 0],
      ['grok-build', 0, false, 0],
      ['opencode', 0, false, 0],
    ]);
    expect(s.daily.map((d) => d.total.tokens)).toEqual([0, 0, 3e6]);
    expect(s.models[0]).toMatchObject({ model: 'claude-opus-5-5', requests: 3 });
  });

  it('shows tokens without prices', () => {
    const s = summarize(report, 7, null);
    expect(s.total.tokens).toBe(4e6);
    expect(s.total.cost).toBe(0);
    expect(s.total.unpriced).toBe(4e6);
    expect(s.total.sessions).toBe(3);
  });
});
