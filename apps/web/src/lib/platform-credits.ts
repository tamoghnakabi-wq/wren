import { getVercelOidcToken } from '@vercel/oidc';
import { env } from './env';
import { HttpError } from './auth';

// Wren credits: the "platform" model source, where model usage is billed to the operator's Vercel AI Gateway
// account through this deployment's OIDC token.
//
// OFF for every account since 2026-10-07. The implementation is kept: every path that could spend the credits goes
// through this file — runs in the cloud (lib/models.ts), the desktop model proxy, the model list — and each checks
// assertPlatformAllowed() and takes the token only from operatorGatewayToken(), which refuses while this is off.
// To turn Wren credits back on, set PLATFORM_CREDITS_ENABLED to true and deploy; PLATFORM_MODEL_USERS then decides
// which accounts may use them, as before. It is a constant rather than an environment variable on purpose: turning
// spending back on takes a reviewed change, not a dashboard setting.
export const PLATFORM_CREDITS_ENABLED = false;

export const PLATFORM_DISABLED_MESSAGE =
  'Wren credits are turned off for now. Choose another brain for this agent: an API key in Connections, or a plan on your computer.';

/** Whether this account may use Wren credits right now (also what the UI shows). */
export function canUsePlatform(user: { email: string }): boolean {
  return PLATFORM_CREDITS_ENABLED && env.platformModelUsers.includes(user.email.toLowerCase());
}

/** Throws unless this account may spend Wren credits right now. */
export function assertPlatformAllowed(user: { email: string }): void {
  if (!PLATFORM_CREDITS_ENABLED) throw new HttpError(403, PLATFORM_DISABLED_MESSAGE, 'platform_disabled');
  if (!env.platformModelUsers.includes(user.email.toLowerCase())) {
    throw new HttpError(403, 'Wren credits are not enabled for this account. Connect your own provider in Connections.', 'platform_denied');
  }
}

/**
 * The deployment's credential for the operator's AI Gateway account: the only way Wren obtains it for model calls.
 * Checked again on every use, so a model client created before the switch went off can't keep spending.
 */
export async function operatorGatewayToken(): Promise<string> {
  if (!PLATFORM_CREDITS_ENABLED) throw new HttpError(403, PLATFORM_DISABLED_MESSAGE, 'platform_disabled');
  return getVercelOidcToken();
}
