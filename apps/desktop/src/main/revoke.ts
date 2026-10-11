import { APP_URL, readSecret, writeSecret } from './config';

// Device tokens this computer gave back (Unlink, or a link declined or superseded here). Each is kept,
// encrypted, until the server confirms it no longer accepts it, and retried until then: a failure is
// never just forgotten (W-148).

interface Pending {
  token: string;
  appUrl: string;
}
const FILE = 'revoke-pending.bin';

const pending = (): Pending[] => readSecret<Pending[]>(FILE) ?? [];
function save(list: Pending[]) {
  try {
    writeSecret(FILE, list.length ? list : null);
  } catch {
    /* no secure storage: then there was no token stored either */
  }
}

/** Ask the server to stop accepting `token`: true once it confirms, or already didn't accept it (401). */
export async function revokeToken(token: string, appUrl = APP_URL): Promise<boolean> {
  try {
    const res = await fetch(`${appUrl}/api/device/unlink`, { method: 'POST', headers: { authorization: `Device ${token}` }, signal: AbortSignal.timeout(10_000) });
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

/**
 * Give `token` back. It is recorded first (before anything else happens to the caller's copy), so a
 * failure, or Wren quitting, leaves it to be retried. True when the server confirmed it now.
 */
export async function giveBack(token: string, appUrl = APP_URL): Promise<boolean> {
  save([...pending().filter((p) => p.token !== token), { token, appUrl }]);
  if (!(await revokeToken(token, appUrl))) return false;
  save(pending().filter((p) => p.token !== token));
  return true;
}

/** Try every token still waiting to be given back; how many are still waiting. */
export async function retryGiveBacks(): Promise<number> {
  for (const p of pending()) {
    if (await revokeToken(p.token, p.appUrl)) save(pending().filter((x) => x.token !== p.token));
  }
  return pending().length;
}
