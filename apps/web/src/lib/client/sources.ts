// Model sources as presented in the product. The honesty notes here are shown
// in the UI wherever a user picks how an agent's model is paid for.

export interface SourceInfo {
  id: string;
  label: string;
  provider: 'openai' | 'anthropic' | 'xai' | 'vercel' | 'local' | 'wren' | 'test';
  short: string;
  detail: string;
  desktopOnly?: boolean;
  usesSubscription?: boolean;
  needs?: 'api-key' | 'device' | 'none';
}

export const SOURCES: SourceInfo[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    short: 'ChatGPT plan or API key',
    detail:
      'On your computer, Wren can use your ChatGPT Plus/Pro plan through the official “Sign in with ChatGPT”. In the cloud, OpenAI only allows API-key billing, so cloud runs use your OpenAI API key. Choose which you prefer in Settings.',
    usesSubscription: true,
    needs: 'none',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    provider: 'anthropic',
    short: 'Your Claude plan, on your computer',
    detail:
      'Runs Anthropic’s own Claude Code app on your computer, signed in with your Claude account through Anthropic’s login. Usage counts toward your Claude plan. Anthropic does not allow Claude subscriptions in third-party clouds, so this only runs on your computer and Wren never sees your Claude credentials.',
    desktopOnly: true,
    usesSubscription: true,
    needs: 'device',
  },
  {
    id: 'anthropic',
    label: 'Anthropic API',
    provider: 'anthropic',
    short: 'Claude models with your API key',
    detail: 'Uses your Anthropic Console API key (pay-as-you-go). Works in the cloud and on your computer.',
    needs: 'api-key',
  },
  {
    id: 'grok-build',
    label: 'Grok Build',
    provider: 'xai',
    short: 'Your SuperGrok / X Premium plan, on your computer',
    detail:
      'Runs xAI’s official Grok Build CLI on your computer, signed in with your own xAI account. xAI has not published a way for third-party apps to use Grok subscriptions directly, so Wren only drives the official CLI and never handles your xAI login.',
    desktopOnly: true,
    usesSubscription: true,
    needs: 'device',
  },
  { id: 'xai', label: 'xAI API', provider: 'xai', short: 'Grok models with your API key', detail: 'Uses your xAI API key (pay-as-you-go). Works in the cloud and on your computer.', needs: 'api-key' },
  { id: 'gateway', label: 'Vercel AI Gateway', provider: 'vercel', short: 'Hundreds of models, one key', detail: 'Uses your Vercel AI Gateway API key. Billed by Vercel.', needs: 'api-key' },
  {
    id: 'local',
    label: 'Local model',
    provider: 'local',
    short: 'LM Studio, Ollama… on your computer',
    detail: 'Uses any OpenAI-compatible model server running on your computer. Free and private; quality depends on the model.',
    desktopOnly: true,
    needs: 'device',
  },
  { id: 'platform', label: 'Wren credits', provider: 'wren', short: 'Provided by this Wren instance', detail: 'Model usage paid by the operator of this Wren instance (enabled per account).', needs: 'none' },
  { id: 'test', label: 'Test model', provider: 'test', short: 'Scripted, for automated tests', detail: 'Deterministic scripted model used by end-to-end tests.', needs: 'none' },
];

export const sourceInfo = (id: string | undefined) => SOURCES.find((s) => s.id === id);

export interface ModelChoice {
  id: string;
  name: string;
  description?: string;
}

/** What the engines offer before any computer has reported its CLI's own list (desktop app 0.1.42 and older). */
export const ENGINE_MODELS: Record<string, ModelChoice[]> = {
  'claude-code': [
    { id: 'default', name: 'Plan default' },
    { id: 'opus', name: 'Opus (latest)' },
    { id: 'fable', name: 'Fable (latest)' },
    { id: 'sonnet', name: 'Sonnet (latest)' },
    { id: 'haiku', name: 'Haiku (latest)' },
  ],
  'grok-build': [{ id: 'default', name: 'Grok Build default' }],
};

/**
 * Claude Code names its models briefly ("Opus") and starts the description with the version ("Opus 5.5 ·
 * Best for everyday, complex tasks"): the picker shows "Opus 5.5" and keeps the rest as the description.
 */
export function engineChoice(m: ModelChoice): ModelChoice {
  const parts = (m.description ?? '').split(' · ').map((s) => s.trim()).filter(Boolean);
  const head = parts[0];
  if (parts.length < 2 || !/\d/.test(head) || head.length > 32) return m;
  const name = head.toLowerCase().startsWith(m.name.toLowerCase()) ? head : `${m.name} – ${head}`;
  return { id: m.id, name, description: parts.slice(1).join(' · ') };
}

/**
 * The models an engine offers: what the desktop app read from the CLI on each of the user's computers
 * (merged, first seen wins), or the built-in list until one has reported. Grok Build lists only model
 * ids, so its "default" (whatever Grok picks) stays first. The agent's current model is always kept.
 */
export function engineModels(source: string, reported: (ModelChoice[] | undefined)[], current?: string): ModelChoice[] {
  const fallback = ENGINE_MODELS[source] ?? [];
  const got = reported.flatMap((l) => (Array.isArray(l) ? l : [])).filter((m) => typeof m?.id === 'string' && m.id && typeof m.name === 'string');
  const list: ModelChoice[] = [];
  const add = (m: ModelChoice) => void (list.some((x) => x.id === m.id) || list.push(m));
  if (got.length) {
    if (!got.some((m) => m.id === 'default')) add(fallback.find((m) => m.id === 'default') ?? { id: 'default', name: 'Default' });
    got.forEach((m) => add(engineChoice(m)));
  } else fallback.forEach(add);
  if (current) add({ id: current, name: current });
  return list;
}

export function modelLabel(source: string | undefined, model: string | undefined): string {
  if (!model) return 'No model';
  const s = sourceInfo(source);
  const m = model === 'default' ? 'default model' : model.replace(/^[a-z]+\//, '');
  return s ? `${m} · ${s.label}` : m;
}
