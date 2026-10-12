import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { APP_URL, dataDir, writeSecret } from './config';

// Device tokens this computer gave back (Unlink, or a link declined or superseded here). Each is kept,
// encrypted, until the server confirms it no longer accepts it, and retried until then: a failure is
// never just forgotten (W-148). New ones go in the main record; a record that can't be read when one is
// added (the keychain locked, a read error, a reset keychain) is set aside as a "held" record and
// retried along with the main one, so nothing is ever dropped because it couldn't be read once (W-155).

interface Pending {
  token: string;
  appUrl: string;
}
const MAIN = 'revoke-pending.bin';
const HELD = /^revoke-pending\.(held|unreadable)-[\w-]+\.bin$/; // `unreadable-` from 0.1.24

const valid = (x: unknown): x is Pending => !!x && typeof (x as Pending).token === 'string' && typeof (x as Pending).appUrl === 'string';

/** A record's tokens (a damaged entry is skipped, not the whole record); null if it can't be read now. */
function read(name: string): Pending[] | null {
  try {
    const p = join(dataDir(), name);
    if (!existsSync(p) || statSync(p).size === 0) return [];
    if (!safeStorage.isEncryptionAvailable()) return null;
    const list: unknown = JSON.parse(safeStorage.decryptString(readFileSync(p)));
    return Array.isArray(list) ? list.filter(valid) : null;
  } catch {
    return null;
  }
}

function write(name: string, list: Pending[]): boolean {
  try {
    if (list.length) writeSecret(name, list);
    else if (name === MAIN) writeSecret(name, null);
    else rmSync(join(dataDir(), name), { force: true });
    return true;
  } catch {
    return false; // no secure storage, or the disk refused
  }
}

/** The main record's tokens, setting it aside (kept, retried later) if it can't be read now. */
function mainList(): Pending[] | null {
  const list = read(MAIN);
  if (list) return list;
  try {
    renameSync(join(dataDir(), MAIN), join(dataDir(), `revoke-pending.held-${Date.now()}-${randomBytes(4).toString('hex')}.bin`));
    return [];
  } catch {
    return null;
  }
}

function drop(name: string, token: string) {
  const list = read(name);
  if (list) write(name, list.filter((p) => p.token !== token));
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
  const list = mainList();
  const kept = list !== null && write(MAIN, [...list.filter((p) => p.token !== token), { token, appUrl }]);
  if (await revokeToken(token, appUrl)) {
    drop(MAIN, token);
    return 'confirmed';
  }
  return kept ? 'pending' : 'failed';
}

/** Try every token still waiting, in every record; how many tokens (and unreadable records) are left. */
export async function retryGiveBacks(): Promise<number> {
  let held: string[] = [];
  try {
    held = readdirSync(dataDir()).filter((f) => HELD.test(f));
  } catch {
    /* the data folder can't be listed now: the main record still goes */
  }
  let left = 0;
  for (const name of [MAIN, ...held]) {
    const list = read(name);
    if (!list) {
      left++; // can't be read now: tried again next time
      continue;
    }
    for (const p of list) {
      if (await revokeToken(p.token, p.appUrl)) drop(name, p.token);
    }
    const now = read(name);
    if (now && !now.length && name !== MAIN) rmSync(join(dataDir(), name), { force: true });
    left += now?.length ?? 1;
  }
  return left;
}
