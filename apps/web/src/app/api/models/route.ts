import { getVercelOidcToken } from '@vercel/oidc';
import { listModels, type ModelSource } from '@wren/core';
import { HttpError, requireUser } from '@/lib/auth';
import { env } from '@/lib/env';
import { json, route } from '@/lib/http';
import { canUsePlatform, connectionSecret } from '@/lib/models';

// Models available to one of the user's server-side model sources.
export const GET = route(async (req) => {
  const user = await requireUser(req);
  const url = new URL(req.url);
  const source = url.searchParams.get('source') ?? '';
  if (source === 'test') {
    if (!env.testModel) throw new HttpError(404, 'Not available', 'not_found');
    return json({ models: [{ id: 'scripted', name: 'Scripted test model' }] });
  }
  if (source === 'platform') {
    if (!canUsePlatform(user)) throw new HttpError(403, 'Wren credits are not enabled for this account.', 'platform_denied');
    const models = await listModels('platform', await getVercelOidcToken());
    return json({ models: models.filter((m) => /^(openai|anthropic|xai|spacexai|google)\//.test(m.id)) });
  }
  if (!['openai', 'anthropic', 'xai', 'gateway'].includes(source)) throw new HttpError(400, 'Unknown source', 'invalid');
  const key = await connectionSecret(user.id, source, url.searchParams.get('connectionId') ?? undefined);
  if (!key) return json({ models: [], needsConnection: true });
  try {
    const models = await listModels(source as ModelSource, key.secret);
    return json({ models: models.sort((a, b) => b.id.localeCompare(a.id)) });
  } catch (e) {
    return json({ models: [], error: (e as Error).message });
  }
});
