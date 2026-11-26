import { describe, expect, it } from 'vitest';
import { parseClaudeLimits } from '../src/main/plan-limits';

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
