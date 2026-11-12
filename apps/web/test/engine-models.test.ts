import { describe, expect, it } from 'vitest';
import { effortChoices, ENGINE_MODELS, engineChoice, engineModels } from '../src/lib/client/sources';

// Claude Code and Grok Build list their own models (desktop app 0.1.43+); the agent form offers those.

// What Claude Code 2.1.319 lists for a Max plan, as the desktop app reports it.
const claude = [
  { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { id: 'opus', name: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks · ~2× usage vs Sonnet' },
  { id: 'claude-fable-5-1[1m]', name: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks' },
  { id: 'sonnet', name: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks' },
  { id: 'haiku', name: 'Haiku', description: 'Haiku 5.5 · Fastest for quick answers' },
];

describe('engine model choices', () => {
  it("shows Claude Code's models by version, keeping the rest as the description", () => {
    expect(engineModels('claude-code', [claude]).map((m) => [m.id, m.name, m.description])).toEqual([
      ['default', 'Default (recommended) – Opus 5.5', 'Best for everyday, complex tasks'],
      ['opus', 'Opus 5.5', 'Best for everyday, complex tasks · ~2× usage vs Sonnet'],
      ['claude-fable-5-1[1m]', 'Fable 5.1', 'Most capable for your hardest and longest-running tasks'],
      ['sonnet', 'Sonnet 5.5', 'Efficient for routine tasks'],
      ['haiku', 'Haiku 5.5', 'Fastest for quick answers'],
    ]);
  });

  it('leaves a model alone when its description does not start with a version', () => {
    const m = { id: 'claude-opus-5', name: 'Opus 5', description: 'Best for everyday, complex tasks' };
    expect(engineChoice(m)).toEqual(m);
    expect(engineChoice({ id: 'x', name: 'X', description: 'Fast · cheap' })).toEqual({ id: 'x', name: 'X', description: 'Fast · cheap' });
  });

  it("keeps Grok Build's own default first, then the models Grok lists", () => {
    const list = engineModels('grok-build', [[{ id: 'grok-4.7', name: 'grok-4.7', description: 'Grok Build’s default' }]]);
    expect(list.map((m) => m.id)).toEqual(['default', 'grok-4.7']);
    expect(list[0].name).toBe('Grok Build default');
  });

  it('merges every computer, and falls back to the built-in list until one reports', () => {
    const two = engineModels('grok-build', [[{ id: 'grok-4.7', name: 'grok-4.7' }], undefined, [{ id: 'grok-4.7', name: 'grok-4.7' }, { id: 'grok-code-2', name: 'grok-code-2' }]]);
    expect(two.map((m) => m.id)).toEqual(['default', 'grok-4.7', 'grok-code-2']);
    expect(engineModels('claude-code', [undefined, []])).toEqual(ENGINE_MODELS['claude-code']);
  });

  it("keeps the agent's current model even when no computer offers it any more", () => {
    expect(engineModels('claude-code', [claude], 'claude-opus-4-6').at(-1)).toEqual({ id: 'claude-opus-4-6', name: 'claude-opus-4-6' });
    expect(engineModels('claude-code', [claude], 'opus').filter((m) => m.id === 'opus')).toHaveLength(1);
  });
});

describe('effort choices', () => {
  const all = ['low', 'medium', 'high', 'xhigh', 'max'];

  it("offers the levels a model lists itself, kept through Claude Code's naming", () => {
    const [opus] = engineModels('claude-code', [[{ id: 'opus', name: 'Opus', description: 'Opus 5.5 · Best for everyday tasks', efforts: all }]]).slice(1);
    expect(opus).toMatchObject({ name: 'Opus 5.5', efforts: all });
    expect(effortChoices('claude-code', opus)).toEqual({ levels: all, byDefault: undefined });
    expect(effortChoices('openai', { id: 'gpt-5.6-terra', name: 'Terra', efforts: [...all, 'ultra'] })?.levels.at(-1)).toBe('ultra');
    expect(effortChoices('anthropic', { id: 'claude-opus-4-6', name: 'Opus 4.6', efforts: ['max', 'low', 'medium', 'high'] })?.levels).toEqual(['low', 'medium', 'high', 'max']);
  });

  it("falls back to the brain's usual levels, and names the default Wren or the CLI uses", () => {
    expect(effortChoices('claude-code', { id: 'opus', name: 'Opus' })).toEqual({ levels: ['low', 'medium', 'high'], byDefault: undefined });
    expect(effortChoices('grok-build', { id: 'grok-4.7', name: 'grok-4.7' })).toEqual({ levels: ['low', 'medium', 'high', 'xhigh'], byDefault: 'high' });
    expect(effortChoices('openai', undefined)).toEqual({ levels: ['low', 'medium', 'high'], byDefault: 'medium' });
  });

  it("offers none where Wren doesn't set one, or the model takes none", () => {
    for (const source of ['xai', 'gateway', 'platform', 'local', 'test']) expect(effortChoices(source, { id: 'm', name: 'm' })).toBeNull();
    expect(effortChoices('claude-code', { id: 'claude-haiku-4-5', name: 'Haiku 4.5', efforts: [] })).toBeNull();
  });

  it("keeps the agent's saved level listed, and ignores levels Wren doesn't know", () => {
    expect(effortChoices('claude-code', { id: 'claude-haiku-4-5', name: 'Haiku 4.5', efforts: [] }, 'low')?.levels).toEqual(['low']);
    expect(effortChoices('anthropic', { id: 'm', name: 'm', efforts: ['low', 'warp-9'] }, 'max')?.levels).toEqual(['low', 'max']);
    expect(effortChoices('anthropic', { id: 'm', name: 'm', efforts: ['low'] }, 'warp-9')?.levels).toEqual(['low']);
  });
});
