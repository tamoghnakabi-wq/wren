// Linking this computer to an account: a device-code flow. The page starts it (it shows the code, or
// approves it at once in the app), the server hands the device token out once, and the user confirms here
// which account it goes to (W-142, W-145).

export interface PairStart {
  pairId: string;
  userCode: string;
  pollSecret: string;
  interval?: number;
  error?: string;
}

export interface PairAnswer {
  status: string;
  deviceId?: string;
  token?: string;
  channel?: string;
  account?: { email?: string; name?: string };
  supabase?: { url: string; key: string };
}

export interface PairingDeps {
  start(): Promise<{ status: number; data: PairStart }>;
  poll(pairId: string, pollSecret: string): Promise<{ status: number; data: PairAnswer } | null>;
  /** Ask the user (natively) whether to link to this account. */
  confirm(email: string | undefined): Promise<boolean>;
  /** Already linked (then a delivery is given back). */
  linked(): boolean;
  save(answer: PairAnswer & { token: string }): void;
  /** Give a delivered token back to the server. */
  revoke(token: string): Promise<void>;
  sleep?(ms: number): Promise<void>;
}

export function createPairing(deps: PairingDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** The attempt under way; a newer one supersedes it (by generation). */
  let current: { pairId: string; pollSecret: string; gen: number } | null = null;
  let gen = 0;
  let confirming = false;

  /** One poll at a time: the server hands the token out once, so no other answer may overtake it. */
  async function poll(me: NonNullable<typeof current>, every: number) {
    const until = Date.now() + 15 * 60_000;
    while (current === me && Date.now() < until) {
      await sleep(every);
      if (current !== me) return;
      const r = await deps.poll(me.pairId, me.pollSecret).catch(() => null);
      if (r?.data.status === 'approved' && r.data.token) {
        if (current === me) current = null;
        return finish(me.gen, { ...r.data, token: r.data.token });
      }
      if (r?.status === 410) break;
    }
    if (current === me) current = null;
  }

  /** Save the delivery once the user confirmed the account; otherwise give the token back. */
  async function finish(g: number, d: PairAnswer & { token: string }) {
    let ok = false;
    if (g === gen) {
      confirming = true;
      try {
        ok = await deps.confirm(d.account?.email);
      } catch {
        ok = false;
      } finally {
        confirming = false;
      }
    }
    // A newer attempt, or a link made meanwhile, wins over this one.
    if (!ok || g !== gen || deps.linked()) return deps.revoke(d.token).catch(() => {});
    deps.save(d);
  }

  return {
    /** The user is being asked which account to link to. */
    get confirming() {
      return confirming;
    },
    async start(): Promise<{ userCode: string; pairId: string }> {
      const g = ++gen; // supersedes any attempt still polling
      current = null;
      const { status, data } = await deps.start();
      if (g !== gen) throw new Error('Linking was started again.');
      if (status !== 200) throw new Error(data.error ?? 'Could not start linking.');
      const me = { pairId: data.pairId, pollSecret: data.pollSecret, gen: g };
      current = me;
      void poll(me, Math.max(1, data.interval ?? 2) * 1000);
      return { userCode: data.userCode, pairId: data.pairId };
    },
  };
}
