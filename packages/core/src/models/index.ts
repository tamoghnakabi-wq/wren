import type { ImageRef, ModelClient, ModelSource } from '../types';
import { AnthropicClient } from './anthropic';
import { ChatClient } from './chat';
import { ResponsesClient } from './responses';

export { AnthropicClient } from './anthropic';
export { ChatClient } from './chat';
export { ResponsesClient } from './responses';

export interface ClientOptions {
  source: ModelSource;
  /** API key, OAuth access token, or OIDC token depending on the source. */
  credential?: string | (() => Promise<string>);
  baseUrl?: string; // local servers
  loadImage?: (ref: ImageRef) => Promise<{ mime: string; data: string } | null>;
  fetch?: typeof fetch;
}

export const PROVIDER_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  chatgpt: 'https://api.openai.com/v1',
  xai: 'https://api.x.ai/v1',
  gateway: 'https://ai-gateway.vercel.sh/v1',
  platform: 'https://ai-gateway.vercel.sh/v1',
  anthropic: 'https://api.anthropic.com',
};

export function createModelClient(o: ClientOptions): ModelClient {
  const cred = async () => (typeof o.credential === 'function' ? o.credential() : o.credential ?? '');
  const bearer = async () => ({ authorization: `Bearer ${await cred()}` });
  switch (o.source) {
    case 'openai':
      return new ResponsesClient({ origin: 'openai', baseUrl: PROVIDER_BASE.openai, headers: bearer, namespaces: true, encryptedReasoning: true, webSearch: true, reasoningParams: true, loadImage: o.loadImage, fetch: o.fetch });
    case 'chatgpt':
      return new ResponsesClient({ origin: 'chatgpt', baseUrl: PROVIDER_BASE.chatgpt, headers: bearer, namespaces: true, chatgptPlan: true, encryptedReasoning: true, webSearch: true, reasoningParams: true, loadImage: o.loadImage, fetch: o.fetch });
    case 'xai':
      return new ResponsesClient({ origin: 'xai', baseUrl: PROVIDER_BASE.xai, headers: bearer, namespaces: false, webSearch: true, loadImage: o.loadImage, fetch: o.fetch });
    case 'gateway':
    case 'platform':
      return new ResponsesClient({ origin: o.source, baseUrl: PROVIDER_BASE.gateway, headers: bearer, namespaces: false, loadImage: o.loadImage, fetch: o.fetch });
    case 'anthropic': {
      if (typeof o.credential !== 'string') throw new Error('Anthropic requires an API key.');
      return new AnthropicClient({ apiKey: o.credential, loadImage: o.loadImage });
    }
    case 'local':
      return new ChatClient({ origin: 'local', baseUrl: o.baseUrl ?? 'http://127.0.0.1:1234/v1', loadImage: o.loadImage, fetch: o.fetch, vision: true });
    default:
      throw new Error(`Model source "${o.source}" runs as an external engine, not through the agent loop.`);
  }
}

export interface ModelInfo {
  id: string;
  name: string;
}

/** List models available to a credential (used for pickers and connection checks). */
export async function listModels(source: ModelSource, credential: string, f: typeof fetch = fetch, baseUrl?: string): Promise<ModelInfo[]> {
  if (source === 'anthropic') {
    const res = await f('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': credential, 'anthropic-version': '2023-06-01' } });
    if (!res.ok) throw new Error(await errorText(res));
    const j = (await res.json()) as { data: { id: string; display_name?: string }[] };
    return j.data.map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
  }
  const base = source === 'local' ? baseUrl ?? 'http://127.0.0.1:1234/v1' : PROVIDER_BASE[source];
  const res = await f(`${base}/models`, { headers: credential ? { authorization: `Bearer ${credential}` } : {} });
  if (!res.ok) throw new Error(await errorText(res));
  const j = (await res.json()) as { data?: { id: string; name?: string; type?: string }[]; models?: { slug: string; display_name?: string; visibility?: string }[] };
  if (j.models) {
    // ChatGPT-plan catalog shape
    return j.models.filter((m) => !m.visibility || m.visibility === 'list').map((m) => ({ id: m.slug, name: m.display_name ?? m.slug }));
  }
  let list = (j.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id, type: m.type }));
  if (source === 'openai') list = list.filter((m) => /^(gpt|o\d|chatgpt|computer-use)/.test(m.id) && !/(audio|realtime|tts|transcribe|image|embedding|search-preview|moderation|instruct)/.test(m.id));
  if (source === 'gateway' || source === 'platform') list = list.filter((m) => !m.type || m.type === 'language');
  if (source === 'xai') list = list.filter((m) => /grok/.test(m.id) && !/(image|imagine|video|vision-only)/.test(m.id));
  return list.map(({ id, name }) => ({ id, name }));
}

async function errorText(res: Response): Promise<string> {
  const t = await res.text().catch(() => '');
  try {
    const j = JSON.parse(t);
    return `${res.status}: ${j.error?.message ?? j.detail ?? t}`.slice(0, 300);
  } catch {
    return `${res.status}: ${t}`.slice(0, 300);
  }
}
