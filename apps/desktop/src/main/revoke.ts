import { safeStorage } from 'electron';
import { existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { APP_URL, dataDir, readSecret, writeSecret } from './config';

// Device tokens this computer gave back (Unlink, or a link declined or superseded here). Each is kept,
// encrypted, until the server confirms it no longer accepts it, and retried until then: a failure is
// never just forgotten (W-148).

interface Pending {
  token: string;
  appUrl: string;
}
const FILE = 'revoke-pending.bin';

const valid = (x: unknown): x is Pending => !!x && typeof (x as Pending).token === 'string' && typeof (x as Pending).appUrl === 'string';

/**
 * The tokens still waiting. Null when they can't be read right now (secure storage unavailable, or the
 * file can't be checked): the record is then left as it is. A record secure storage can't decrypt (the
 * keychain was reset) or that isn't a list is moved aside, not deleted, so it doesn't block every later
 * give-back.
 */
function load(): Pending[] | null {
  try {
    const p = join(dataDir(), FILE);
    if (!existsSync(p) || statSync(p).size === 0) return [];
    if (!safeStorage.isEncryptionAvailable()) return null;
    const list = readSecret<unknown>(FILE);
    if (Array.isArray(list) && list.every(valid)) return list;
    renameSync(p, join(dataDir(), `revoke-pending.unreadable-${Date.now()}.bin`));
    return [];
  } catch {
    return null;
  }
}

function save(list: Pending[]): boolean {
  try {
    writeSecret(FILE, list.length ? list : null);
    return true;
  } catch {
    return false; // no secure storage, or the disk refused
  }
}

function drop(token: string) {
  const list = load();
  if (list) save(list.filter((p) => p.token !== token));
}

/**
 * Ask the server to stop accepting `token`. Only Wren's own answers count: done (`ok: true`), or this
 * token isn't accepted any more (401 `device_revoked`). Anything else, such as a proxy's 401, a sign-in
 * page or a redirect, leaves it to be retried (W-150).
 */
export async function revokeToken(token: string, appUrl = APP_URL): Promise<boolean> {
  try {
    const res = await fetch(`${appUrl}/api/device/unlink`, { method: 'POST', headers: { authorization: `Device ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const body = (await res.json().catch(() => null)) as { ok?: unknown; code?: unknown } | null;
    return (res.ok && body?.ok === true) || (res.status === 401 && body?.code === 'device_revoked');
  } catch {
    return false;
  }
}

/**
 * Give `token` back. It is recorded first (before anything else happens to the caller's copy), so a
 * failure, or Wren quitting, leaves it to be retried. `confirmed`: the server no longer accepts it;
 * `pending`: recorded, and retried; `failed`: neither (it couldn't be recorded either).
 */
export async function giveBack(token: string, appUrl = APP_URL): Promise<'confirmed' | 'pending' | 'failed'> {
  const list = load();
  const kept = list !== null && save([...list.filter((p) => p.token !== token), { token, appUrl }]);
  if (await revokeToken(token, appUrl)) {
    drop(token);
    return 'confirmed';
  }
  return kept ? 'pending' : 'failed';
}

/** Try every token still waiting to be given back; how many are still waiting. */
export async function retryGiveBacks(): Promise<number> {
  for (const p of load() ?? []) {
    if (await revokeToken(p.token, p.appUrl)) drop(p.token);
  }
  return (load() ?? []).length;
}
