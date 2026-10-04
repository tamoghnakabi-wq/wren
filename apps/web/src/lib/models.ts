import { getVercelOidcToken } from '@vercel/oidc';
import {
  createModelClient,
  DESKTOP_ONLY_SOURCES,
  ENGINE_SOURCES,
  resolveOpenAIRoute,
  ScriptedModel,
  type ImageRef,
  type ModelClient,
  type ModelRef,
  type OpenAIAccess,
  type Runtime,
} from '@wren/core';
import { db } from './db';
import { decryptSecret } from './crypto';
import { env } from './env';
import { HttpError, type AuthUser } from './auth';

export interface ModelAccess {
  client: ModelClient;
  source: string; // what actually pays: openai | chatgpt | anthropic | ...
  model: string;
  note?: string;
  webSearch: boolean;
}

export interface UserSettings {
  openaiAccess: OpenAIAccess;
  openaiAllowFallback: boolean;
  timezone: string;
}

export async function userSettings(userId: string): Promise<UserSettings> {
  const [p] = await db()`select settings, timezone from public.profiles where id = ${userId}`;
  const s = (p?.settings ?? {}) as Record<string, unknown>;
  return {
    openaiAccess: s.openaiAccess === 'api' ? 'api' : 'chatgpt',
    openaiAllowFallback: s.openaiAllowFallback !== false,
    timezone: String(p?.timezone ?? 'UTC'),
  };
}

export async function connectionSecret(userId: string, provider: string, connectionId?: string): Promise<{ id: string; secret: string } | null> {
  const sql = db();
  const rows = connectionId
    ? await sql`select c.id, s.ciphertext from public.connections c join public.connection_secrets s on s.connection_id = c.id
                where c.id = ${connectionId} and c.user_id = ${userId} and c.provider = ${provider} and c.status <> 'disabled'`
    : await sql`select c.id, s.ciphertext from public.connections c join public.connection_secrets s on s.connection_id = c.id
                where c.user_id = ${userId} and c.provider = ${provider} and c.status <> 'disabled' order by c.created_at limit 1`;
  if (!rows.length) return null;
  return { id: rows[0].id, secret: decryptSecret(rows[0].ciphertext, userId) };
}

export function canUsePlatform(user: Pick<AuthUser, 'email'>) {
  return env.platformModelUsers.includes(user.email.toLowerCase());
}

/** Model access for a run executing in our cloud (Vercel Functions). */
export async function resolveCloudModel(
  user: Pick<AuthUser, 'id' | 'email'>,
  ref: ModelRef,
  loadImage: (ref: ImageRef) => Promise<{ mime: string; data: string } | null>,
): Promise<ModelAccess> {
  const source = ref.source as string;
  if (source === 'test') {
    if (!env.testModel) throw new HttpError(400, 'The test model is disabled.', 'model_unavailable');
    return { client: new ScriptedModel(), source: 'test', model: 'scripted', webSearch: false };
  }
  if (ENGINE_SOURCES.includes(ref.source) || (DESKTOP_ONLY_SOURCES.includes(ref.source) && ref.source !== 'chatgpt')) {
    throw new HttpError(400, 'This model only runs on your computer. Switch the agent to run on a desktop device.', 'desktop_only');
  }
  if (source === 'openai' || source === 'chatgpt') {
    const settings = await userSettings(user.id);
    const key = await connectionSecret(user.id, 'openai', ref.connectionId);
    const route = resolveOpenAIRoute({
      preference: source === 'chatgpt' ? 'chatgpt' : settings.openaiAccess,
      allowFallback: settings.openaiAllowFallback,
      runtime: 'cloud',
      chatgptAvailable: false,
      apiKeyAvailable: !!key,
    });
    if ('error' in route) throw new HttpError(400, route.error, 'no_credentials');
    return { client: createModelClient({ source: 'openai', credential: key!.secret, loadImage }), source: 'openai', model: ref.model, note: route.note, webSearch: true };
  }
  if (source === 'anthropic' || source === 'xai' || source === 'gateway') {
    const key = await connectionSecret(user.id, source, ref.connectionId);
    if (!key) throw new HttpError(400, `Connect your ${source === 'xai' ? 'xAI' : source === 'gateway' ? 'Vercel AI Gateway' : 'Anthropic'} API key in Connections first.`, 'no_credentials');
    return { client: createModelClient({ source: ref.source, credential: key.secret, loadImage }), source, model: ref.model, webSearch: source !== 'gateway' };
  }
  if (source === 'platform') {
    if (!canUsePlatform(user)) throw new HttpError(403, 'Wren credits are not enabled for this account. Connect your own provider in Connections.', 'platform_denied');
    return { client: createModelClient({ source: 'platform', credential: () => getVercelOidcToken(), loadImage }), source, model: ref.model, webSearch: false };
  }
  throw new HttpError(400, `Unknown model source "${source}".`, 'invalid');
}

export function runtimeFor(ref: ModelRef, requested: Runtime): Runtime {
  return DESKTOP_ONLY_SOURCES.includes(ref.source) && ref.source !== 'chatgpt' ? 'desktop' : requested;
}
