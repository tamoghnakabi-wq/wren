import { z } from 'zod';
import { listModels } from '@wren/core';
import { requireUser } from '@/lib/auth';
import { encryptSecret, hint } from '@/lib/crypto';
import { db, type Json } from '@/lib/db';
import { body, json, route } from '@/lib/http';
import { probeMcp } from '@/lib/mcp';

const Schema = z.object({
  provider: z.enum(['openai', 'anthropic', 'xai', 'gateway', 'github', 'mcp']),
  label: z.string().trim().max(60).optional(),
  secret: z.string().trim().max(4000).default(''),
  config: z.object({ url: z.string().url().optional() }).optional(),
});

const LABELS: Record<string, string> = { openai: 'OpenAI API', anthropic: 'Anthropic API', xai: 'xAI API', gateway: 'Vercel AI Gateway', github: 'GitHub', mcp: 'MCP server' };

export const POST = route(async (req) => {
  const user = await requireUser(req);
  const b = await body(req, Schema);
  const config: Record<string, unknown> = {};
  let label = b.label || LABELS[b.provider];

  // Validate the credential before storing it.
  try {
    if (b.provider === 'github') {
      const res = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${b.secret}`, 'user-agent': 'wren-agent', accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub rejected the token (${res.status}).`);
      const u = (await res.json()) as { login: string };
      config.login = u.login;
      config.scopes = res.headers.get('x-oauth-scopes') ?? 'fine-grained';
      label = b.label || `GitHub (${u.login})`;
    } else if (b.provider === 'mcp') {
      if (!b.config?.url) throw new Error('MCP server URL is required.');
      const tools = await probeMcp(b.config.url, b.secret || undefined);
      config.url = b.config.url;
      config.tools = tools.slice(0, 60);
      label = b.label || new URL(b.config.url).hostname;
    } else {
      if (!b.secret) throw new Error('API key is required.');
      const models = await listModels(b.provider, b.secret);
      config.models = models.length;
    }
  } catch (e) {
    return json({ error: (e as Error).message, code: 'invalid_credentials' }, 400);
  }

  // The connection and its secret are saved together or not at all (W-197): an active connection without its
  // secret would show as working and fail every task. Encrypting comes first, so nothing is written if it fails.
  const ciphertext = b.secret ? encryptSecret(b.secret, user.id) : null;
  const sql = db();
  const c = await sql.begin(async (tx) => {
    const [row] = await tx`
      insert into public.connections (user_id, kind, provider, label, config, secret_hint, status, last_checked_at)
      values (${user.id}, ${b.provider === 'github' || b.provider === 'mcp' ? 'service' : 'model'}, ${b.provider}, ${label}, ${tx.json(config as Json)},
              ${b.secret ? hint(b.secret) : null}, 'active', now())
      returning id, kind, provider, label, config, secret_hint, status, created_at`;
    if (ciphertext) await tx`insert into public.connection_secrets (connection_id, ciphertext) values (${row.id}, ${ciphertext})`;
    return row;
  });
  return json(c, 201);
});
