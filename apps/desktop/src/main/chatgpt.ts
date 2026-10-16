import { shell } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { clearSecret, installId, readJson, readSecret, readText, secretDigest, writeJson, writeSecret } from './config';

// "Sign in with ChatGPT" for open-source, locally hosted apps, following
// developers.openai.com/siwc/token-sharing-open-source:
//  - dynamic client registration (client_id=dynamic_agent_client on first use)
//  - loopback redirect http://127.0.0.1:<port>/callback, PKCE S256, state+nonce
//  - ID token validated against OpenAI's JWKS; plan usage requires the
//    chatgpt.tokens.use.direct scope
//  - tokens stored encrypted on this computer only; rotating refresh tokens are
//    refreshed one at a time; sign-out revokes the refresh token.

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const AGENT_NAME = 'Wren';

interface Registration {
  email?: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scopes: string[];
  saved_at: string;
}

export interface ChatGPTStatus {
  signedIn: boolean;
  email?: string;
  planUsage?: boolean;
  error?: string;
}

const SECRET = 'chatgpt.bin';
const HINT_SECRET = 'chatgpt-hint.bin';

/** Stable, opaque host id for this installation (persisted before first sign-in). */
export function hostId(): string {
  const s = readJson<{ chatgptHostId?: string }>('chatgpt-host.json', {});
  if (s.chatgptHostId) return s.chatgptHostId;
  const id = `urn:uuid:${installId()}`;
  writeJson('chatgpt-host.json', { chatgptHostId: id });
  return id;
}

/** Saved client id + login hints survive sign-out so re-auth reuses the registration. */
function savedClient(): { client_id?: string; email?: string; id_token?: string } {
  const c = readJson<{ client_id?: string; email?: string; id_token?: string }>('chatgpt-client.json', {});
  if (c.id_token) {
    // Older versions kept the id token in plain JSON: move it to encrypted storage.
    try {
      writeSecret(HINT_SECRET, { id_token: c.id_token });
      writeJson('chatgpt-client.json', { client_id: c.client_id, email: c.email });
    } catch {
      /* keychain unavailable: leave as is */
    }
  }
  const hint = readSecret<{ id_token?: string }>(HINT_SECRET);
  return { client_id: c.client_id, email: c.email, id_token: hint?.id_token ?? c.id_token };
}

const b64url = (b: Buffer) => b.toString('base64url');
/**
 * Marks a sign-out whose stored sign-in couldn't be removed, so a restart doesn't bring it back (W-185). `of` is
 * the sha256 of the stored bytes it signed out, so a sign-in saved later isn't taken for that one if the marker
 * couldn't be removed; 0.1.31 wrote none, which covers whatever is stored.
 */
const SIGNED_OUT = 'chatgpt-signed-out.json';
interface SignedOut {
  at?: string;
  of?: string;
}
/** Signed out here, but the stored sign-in (`of`, if it could be read) is still on disk: nothing stored is used, and it is removed when possible. */
let clearFailed: { of?: string } | null = null;

/**
 * What the marker says, read strictly: `none` (no file, or the `null` a removal writes), a `marker`, or
 * `unknown` (it can't be read, or isn't a marker). Unknown is never taken for none: a sign-out may be
 * recorded there, so nothing stored is used until it is known again (W-185).
 */
type MarkerState = { kind: 'none' } | { kind: 'marker'; m: SignedOut } | { kind: 'unknown' };
function readMarker(): MarkerState {
  let v: unknown;
  try {
    const text = readText(SIGNED_OUT);
    if (text === null) return { kind: 'none' };
    v = JSON.parse(text);
  } catch {
    return { kind: 'unknown' };
  }
  if (v === null) return { kind: 'none' };
  if (typeof v !== 'object' || Array.isArray(v)) return { kind: 'unknown' };
  const { at, of } = v as Record<string, unknown>;
  if ((at !== undefined && typeof at !== 'string') || (of !== undefined && typeof of !== 'string')) return { kind: 'unknown' };
  return { kind: 'marker', m: { at, of } };
}
/** Whether marker `m` signs out the stored sign-in with this digest (undefined: unknown). */
const covers = (m: SignedOut, digest: string | undefined) => !m.of || m.of === digest;
/** The stored sign-in's digest: null when none is stored, undefined when it can't be read. */
function storedDigest(): string | null | undefined {
  try {
    return secretDigest(SECRET);
  } catch {
    return undefined;
  }
}
/** Writes the marker (synced to disk); true once the one on disk is read back and covers that sign-in. */
function recordSignOut(of: string | undefined): boolean {
  try {
    writeJson(SIGNED_OUT, { at: new Date().toISOString(), of }, { durable: true });
  } catch {
    /* checked below */
  }
  const s = readMarker();
  return s.kind === 'marker' && covers(s.m, of);
}
/**
 * Removes the marker (synced, so it can't outlast what made it stale); true only once it is known to be gone,
 * never because it couldn't be read (an unreadable one is replaced, which also makes it readable again).
 */
function dropMarker(): boolean {
  if (readMarker().kind === 'none') return true;
  try {
    writeJson(SIGNED_OUT, null, { durable: true });
  } catch {
    /* checked below */
  }
  return readMarker().kind === 'none';
}

const load = (): Registration | null => {
  if (clearFailed) {
    // Signed out in this run: nothing stored is used, whatever the marker says. Removed at the first chance,
    // and recorded now if that failed at sign-out.
    if (clearSecret(SECRET)) {
      clearFailed = null;
      dropMarker();
    } else {
      const s = readMarker();
      if (!(s.kind === 'marker' && covers(s.m, clearFailed.of))) recordSignOut(clearFailed.of);
    }
    return null;
  }
  const marker = readMarker();
  if (marker.kind === 'unknown') {
    // A sign-out may be recorded there, so nothing stored is used. Only with nothing stored is it safe to
    // replace; a new sign-in replaces it too.
    if (storedDigest() === null) dropMarker();
    return null;
  }
  if (marker.kind === 'marker') {
    const stored = storedDigest();
    if (stored === undefined) return null; // can't tell which sign-in is stored, so none is used
    if (stored === null) {
      dropMarker(); // nothing stored: the marker is left over
      return null;
    }
    if (covers(marker.m, stored)) {
      // The sign-in that was signed out: never used, removed at the first chance.
      if (clearSecret(SECRET)) dropMarker();
      return null;
    }
    dropMarker(); // saved after that sign-out, so a newer sign-in: the marker is left over
  }
  return readSecret<Registration>(SECRET);
};

export function status(): ChatGPTStatus {
  const r = load();
  if (!r?.refresh_token) return { signedIn: false };
  return { signedIn: true, email: r.email, planUsage: r.scopes.includes(PLAN_SCOPE) };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
async function verifyIdToken(idToken: string, clientId: string, nonce: string | null) {
  if (!jwks) {
    const conf = (await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json()) as { jwks_uri: string };
    jwks = createRemoteJWKSet(new URL(conf.jwks_uri));
  }
  const { payload } = await jwtVerify(idToken, jwks, { issuer: ISSUER, audience: clientId });
  if (nonce !== null && payload.nonce !== nonce) throw new Error('ID token nonce mismatch.');
  if (!payload.sub) throw new Error('ID token has no subject.');
  return payload;
}

let pending: { server: Server; reject: (e: Error) => void } | null = null;

function cancelPending(why: string) {
  if (!pending) return;
  pending.reject(new Error(why));
  pending.server.close();
  pending = null;
}

export async function signIn(opts: { forceConsent?: boolean } = {}): Promise<ChatGPTStatus> {
  cancelPending('Superseded by a new sign-in.');
  // A sign-out or a newer sign-in while this one is open makes it stale: it must not save. Its own
  // generation is taken now, before anything waits, so an older sign-in still exchanging its code can't
  // save over this one (W-184).
  const startGeneration = ++authGeneration;
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const prior = savedClient();
  const host = hostId();

  // Start the loopback listener before opening the browser.
  const server = createServer();
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const params = new URLSearchParams({
    client_id: prior.client_id ?? 'dynamic_agent_client',
    ext_agent_host_id: host,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  if (!prior.client_id) params.set('agent_name_hint', AGENT_NAME);
  if (prior.id_token) params.set('id_token_hint', prior.id_token);
  if (prior.email) params.set('login_hint', prior.email);
  if (opts.forceConsent) params.set('prompt', 'consent');

  const result = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
    pending = { server, reject };
    const timer = setTimeout(() => reject(new Error('Sign-in timed out.')), 10 * 60 * 1000);
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== '/callback') {
        res.statusCode = 404;
        res.end();
        return;
      }
      const page = (title: string, body: string) => {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#f7f5f2;color:#1c1917"><div style="text-align:center"><h1 style="font-weight:600">${title}</h1><p>${body}</p></div></body>`);
      };
      clearTimeout(timer);
      if (url.searchParams.get('state') !== state) {
        page('Sign-in failed', 'The response did not match this sign-in attempt. Please try again from Wren.');
        return reject(new Error('State mismatch.'));
      }
      const err = url.searchParams.get('error');
      if (err) {
        page('Sign-in cancelled', 'You can close this tab and return to Wren.');
        return reject(new Error(url.searchParams.get('error_description') ?? err));
      }
      const code = url.searchParams.get('code');
      const clientId = url.searchParams.get('client_id') ?? prior.client_id;
      if (!code || !clientId) {
        page('Sign-in failed', 'No authorization code was returned.');
        return reject(new Error('No authorization code.'));
      }
      page('You’re signed in', 'You can close this tab and return to Wren.');
      resolve({ code, clientId });
    });
  });

  await shell.openExternal(`${AUTHORIZE}?${params.toString()}`);
  try {
    const { code, clientId } = await result;
    const tok = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE });
    const claims = await verifyIdToken(tok.id_token, clientId, nonce);
    const scopes = String(tok.scope ?? '').split(/\s+/).filter(Boolean);
    const reg: Registration = {
      email: typeof claims.email === 'string' ? claims.email : undefined,
      subject: String(claims.sub),
      client_id: clientId,
      ext_agent_host_id: host,
      id_token: tok.id_token,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: Date.now() + Number(tok.expires_in ?? 3600) * 1000,
      scopes,
      saved_at: new Date().toISOString(),
    };
    if (authGeneration !== startGeneration) throw new Error('Sign-in was cancelled.');
    authGeneration++;
    writeSecret(SECRET, reg);
    clearFailed = null;
    // A sign-out marker that can't be removed names the sign-in it was for, so it doesn't sign out this one.
    // One from 0.1.31 names none and would remove this one at the next read, and one that can't be read might:
    // then this sign-in isn't kept (W-185).
    const left = dropMarker() ? null : readMarker();
    if (left && (left.kind !== 'marker' || covers(left.m, storedDigest() ?? undefined))) {
      clearSecret(SECRET);
      throw new Error('Wren couldn’t keep this sign-in: a file in its data folder can’t be changed. Check that the folder can be written, then sign in again.');
    }
    // Kept for the next sign-in's hints; the id token goes in encrypted storage only.
    writeJson('chatgpt-client.json', { client_id: clientId, email: reg.email });
    writeSecret(HINT_SECRET, { id_token: reg.id_token });
    return status();
  } finally {
    server.close();
    if (pending?.server === server) pending = null;
  }
}

async function tokenRequest(form: Record<string, string>) {
  const res = await fetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  const j = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok) {
    const e = new Error(j.error_description ?? j.error ?? `Token request failed (${res.status})`) as Error & { code?: string };
    e.code = j.error;
    throw e;
  }
  return j as { access_token: string; refresh_token: string; id_token: string; expires_in?: string; scope?: string };
}

let refreshing: { generation: number; promise: Promise<string> } | null = null;
/** Bumped by sign-in and sign-out, so a refresh or sign-in that started earlier can't save stale tokens. */
let authGeneration = 0;

/** A valid access token, refreshed (serialised) when close to expiry. */
export async function accessToken(): Promise<string> {
  // Captured before reading storage: whatever is read belongs to this generation.
  const generation = authGeneration;
  const r = load();
  if (!r?.refresh_token) throw new Error('Not signed in with ChatGPT on this computer.');
  if (r.expires_at - Date.now() > 120_000) return r.access_token;
  if (refreshing?.generation === generation) return refreshing.promise;
  const promise = (async () => {
    try {
      const tok = await tokenRequest({ grant_type: 'refresh_token', client_id: r.client_id, refresh_token: r.refresh_token, resource: RESOURCE });
      if (generation !== authGeneration) throw new Error('Signed out of ChatGPT on this computer.');
      const next: Registration = {
        ...r,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token ?? r.refresh_token,
        id_token: tok.id_token ?? r.id_token,
        expires_at: Date.now() + Number(tok.expires_in ?? 3600) * 1000,
        scopes: tok.scope ? String(tok.scope).split(/\s+/) : r.scopes,
        saved_at: new Date().toISOString(),
      };
      writeSecret(SECRET, next);
      return next.access_token;
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (/invalid_grant|invalid_refresh_token|token_expired|refresh_token_(expired|invalidated|reused)/.test(code)) {
        if (generation === authGeneration) writeSecret(SECRET, { ...r, access_token: '', refresh_token: '' });
        throw new Error('Your ChatGPT sign-in expired or was disconnected. Sign in with ChatGPT again in Settings.');
      }
      throw e;
    } finally {
      if (refreshing?.generation === generation) refreshing = null; // only this refresh can hold that generation
    }
  })();
  refreshing = { generation, promise };
  return promise;
}

export async function signOut(): Promise<{ revoked: boolean; cleared: boolean; recorded: boolean }> {
  // Local sign-out takes effect at once: tokens are gone before any network wait, refreshes and
  // sign-ins already under way can no longer save, and an open sign-in is closed. If the stored
  // sign-in can't be removed, it is still never used again in this run, and a marker naming it keeps it
  // unused after a restart; `recorded` says whether that holds (cleared, or the marker is on disk) (W-185).
  const r = load();
  authGeneration++;
  const cleared = clearSecret(SECRET);
  let recorded = cleared;
  if (!cleared) {
    const of = storedDigest() ?? undefined; // can't be read: the marker then covers whatever is stored
    clearFailed = { of };
    recorded = recordSignOut(of);
  }
  cancelPending('Signed out.');
  let revoked = false;
  if (r?.refresh_token) {
    try {
      const conf = (await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json()) as { revocation_endpoint?: string };
      if (conf.revocation_endpoint) {
        const res = await fetch(conf.revocation_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: r.refresh_token, token_type_hint: 'refresh_token', client_id: r.client_id }),
        });
        revoked = res.ok;
      }
    } catch {
      revoked = false;
    }
  }
  // The client/account mapping and host id stay for a later sign-in.
  return { revoked, cleared, recorded };
}

export async function models(): Promise<{ id: string; name: string }[]> {
  const token = await accessToken();
  const res = await fetch(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const j = (await res.json()) as { models?: { slug: string; display_name?: string; visibility?: string }[]; data?: { id: string }[] };
  if (j.models) return j.models.filter((m) => !m.visibility || m.visibility === 'list').map((m) => ({ id: m.slug, name: m.display_name ?? m.slug }));
  return (j.data ?? []).map((m) => ({ id: m.id, name: m.id }));
}
