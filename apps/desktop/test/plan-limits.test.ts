import { describe, expect, it } from 'vitest';
import { parseClaudeLimits, parseCodexLimits, parseGrokUsage, windowLabel } from '../src/main/plan-limits';

// Usage → This Mac: Claude Code's plan limits from its answer to the get_usage control request (shape as
// Claude Code 2.1.332 answers for a Pro sign-in, values changed).

const line = (response: unknown) => JSON.stringify({ type: 'control_response', response }) + '\n';
const ok = (r: Record<string, unknown>) => line({ subtype: 'success', request_id: 'wren-limits', response: { session: { total_cost_usd: 0 }, behaviors: {}, ...r } });

describe('Claude Code plan limits', () => {
  it('reads the 5-hour and weekly windows and the plan', () => {
    const out =
      '{"type":"system","subtype":"init"}\n' +
      ok({
        subscription_type: 'pro',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 16, resets_at: '2026-11-26T09:40:00.252393+00:00', limit_dollars: null },
          seven_day: { utilization: 66.5, resets_at: '2026-11-28T20:00:00.252410+00:00' },
          seven_day_opus: null,
          seven_day_sonnet: { utilization: 140, resets_at: 'not a date' },
          extra_usage: { is_enabled: false },
          limits: [{ kind: 'session', percent: 16 }],
          model_scoped: [{ display_name: 'Fable', utilization: 3, resets_at: '2026-11-29T00:00:00Z' }, { display_name: '', utilization: 9 }],
        },
      });
    expect(parseClaudeLimits(out)).toEqual({
      app: 'claude-code',
      state: 'ok',
      plan: 'Pro',
      windows: [
        { id: 'session', label: '5-hour limit', minutes: 300, used: 16, resetsAt: Date.parse('2026-11-26T09:40:00.252Z') },
        { id: 'weekly', label: 'Weekly limit', minutes: 10080, used: 66.5, resetsAt: Date.parse('2026-11-28T20:00:00.252Z') },
        { id: 'weekly:sonnet', label: 'Sonnet weekly limit', minutes: 10080, used: 100, resetsAt: null },
        { id: 'weekly:fable', label: 'Fable weekly limit', minutes: 10080, used: 3, resetsAt: Date.parse('2026-11-29T00:00:00Z') },
      ],
    });
  });

  it('says when a sign-in has no plan limits', () => {
    expect(parseClaudeLimits(ok({ subscription_type: null, rate_limits_available: false, rate_limits: null }))).toEqual({ app: 'claude-code', state: 'none', windows: [] });
    expect(parseClaudeLimits(ok({ subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: null } }))).toMatchObject({ state: 'none', plan: 'Max' });
  });

  it('tells an old version from a failed read, and ignores other answers', () => {
    expect(parseClaudeLimits(line({ subtype: 'error', request_id: 'wren-limits', error: 'get_usage is not supported in this context' }))).toMatchObject({ state: 'old', note: 'get_usage is not supported in this context' });
    expect(parseClaudeLimits(line({ subtype: 'error', request_id: 'wren-limits', error: 'Not logged in' }))).toMatchObject({ state: 'failed', note: 'Not logged in' });
    expect(parseClaudeLimits(line({ subtype: 'success', request_id: 'wren-models', response: { rate_limits: { five_hour: { utilization: 1 } } } }))).toMatchObject({ state: 'failed' });
    expect(parseClaudeLimits('')).toEqual({ app: 'claude-code', state: 'failed', windows: [] });
    expect(parseClaudeLimits('{"type":"control_response", wren-limits\n')).toMatchObject({ state: 'failed' });
  });

  it('keeps only a plan name that looks like one', () => {
    const plan = (t: unknown) => parseClaudeLimits(ok({ subscription_type: t, rate_limits_available: false })).plan;
    expect(plan('team')).toBe('Team');
    expect(plan('max_20x')).toBe('Max 20x');
    expect(plan('<script>')).toBeUndefined();
    expect(plan(7)).toBeUndefined();
  });
});

// Codex: its app server's account/rateLimits/read (shape as Codex 0.172 answers for a Go plan, values changed).
describe('Codex plan limits', () => {
  const snap = (primary: unknown, secondary: unknown = null, extra: Record<string, unknown> = {}) => ({ limitId: 'codex', limitName: null, primary, secondary, credits: { hasCredits: false }, planType: 'go', ...extra });
  it('reads its windows, plan and banked resets, and nothing else', () => {
    const res = {
      ordinaryUsageAllowed: true,
      rateLimits: snap({ usedPercent: 12, windowDurationMins: 43200, resetsAt: 1797101424 }),
      rateLimitsByLimitId: {
        codex: snap({ usedPercent: 12, windowDurationMins: 43200, resetsAt: 1797101424 }),
        codex_sol: { limitId: 'codex_sol', limitName: 'GPT-6.1 Sol', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1797000000 }, secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: null } },
      },
      rateLimitResetCredits: { availableCount: 4, credits: [{ id: 'x', title: 'Full reset (Monthly)' }] },
      accountId: 'not-kept',
    };
    expect(parseCodexLimits(res)).toEqual({
      app: 'codex',
      state: 'ok',
      plan: 'Go',
      resetsBanked: 4,
      windows: [
        { id: 'primary', label: 'Monthly limit', minutes: 43200, used: 12, resetsAt: 1797101424000 },
        { id: 'GPT-6.1 Sol:primary', label: 'GPT-6.1 Sol 5-hour limit', minutes: 300, used: 40, resetsAt: 1797000000000 },
        { id: 'GPT-6.1 Sol:secondary', label: 'GPT-6.1 Sol weekly limit', minutes: 10080, used: 3, resetsAt: null },
      ],
    });
    expect(JSON.stringify(parseCodexLimits(res))).not.toContain('not-kept');
  });

  it('a plan with a 5-hour and a weekly window, and an answer with none', () => {
    expect(parseCodexLimits({ rateLimits: snap({ usedPercent: 58, windowDurationMins: 300, resetsAt: 1 }, { usedPercent: 9, windowDurationMins: 10080, resetsAt: 2 }, { planType: 'plus' }) }).windows.map((w) => w.label)).toEqual(['5-hour limit', 'Weekly limit']);
    expect(parseCodexLimits({ rateLimits: null })).toMatchObject({ state: 'none', windows: [] });
    expect(parseCodexLimits('nonsense')).toMatchObject({ state: 'none' });
  });

  it('names windows by their length', () => {
    expect([300, 1440, 10080, 43200, 4320, 120, null].map(windowLabel)).toEqual(['5-hour limit', 'Daily limit', 'Weekly limit', 'Monthly limit', '3-day limit', '2-hour limit', 'Limit']);
  });
});

// Grok Build: `grok usage --json`, which needs Grok's background service; its JSON isn't documented.
describe('Grok Build plan limits', () => {
  it('says when Grok can’t tell here, isn’t signed in, or is a team’s', () => {
    expect(parseGrokUsage({ code: 1, stdout: '', stderr: "Error: `grok usage` can't show your plan's usage here yet. Run /usage inside grok instead." })).toMatchObject({ state: 'unavailable' });
    expect(parseGrokUsage({ code: 1, stdout: '', stderr: 'You are not signed in.' })).toMatchObject({ state: 'failed', note: 'Grok Build isn’t signed in.' });
    expect(parseGrokUsage({ code: 0, stdout: 'Usage limits are managed by your team.', stderr: '' })).toMatchObject({ state: 'none' });
    expect(parseGrokUsage({ code: 0, stdout: '{"nothing": true}', stderr: '' })).toMatchObject({ state: 'failed', note: expect.stringContaining('form Wren doesn’t read') });
  });

  it('reads windows by common field names', () => {
    const out = parseGrokUsage({
      code: 0,
      stdout: JSON.stringify({ plan: 'supergrok', limits: [{ kind: 'weekly', used_percent: 30, resets_at: '2026-11-30T00:00:00Z' }, { label: 'Heavy model', remaining_percent: 75, reset_at: 1797000000 }] }),
      stderr: '',
    });
    expect(out).toEqual({
      app: 'grok-build',
      state: 'ok',
      plan: 'Supergrok',
      windows: [
        { id: 'w0', label: 'Weekly limit', minutes: 10080, used: 30, resetsAt: Date.parse('2026-11-30T00:00:00Z') },
        { id: 'w1', label: 'Heavy model', minutes: null, used: 25, resetsAt: 1797000000000 },
      ],
    });
  });
});
