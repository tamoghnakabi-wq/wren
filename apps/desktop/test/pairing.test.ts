import { describe, expect, it } from 'vitest';
import { createPairing, type PairAnswer, type PairingDeps } from '../src/main/pairing';

const tick = () => new Promise((r) => setTimeout(r, 0));
const approved = (token: string): { status: number; data: PairAnswer } => ({ status: 200, data: { status: 'approved', token, deviceId: 'd', channel: 'c', account: { email: 'me@example.com' }, supabase: { url: 'u', key: 'k' } } });

/** A fake server and user; polls answer in the order the test releases them. */
function setup(over: Partial<PairingDeps> = {}) {
  const log: string[] = [];
  const answers: ((v: { status: number; data: PairAnswer } | null) => void)[] = [];
  let starts = 0;
  let linked = false;
  const deps: PairingDeps = {
    start: async () => ({ status: 200, data: { pairId: `p${++starts}`, userCode: `CODE-${starts}`, pollSecret: 's'.repeat(24), interval: 1 } }),
    poll: (pairId) => (log.push(`poll ${pairId}`), new Promise((r) => answers.push(r))),
    confirm: async (email) => (log.push(`confirm ${email}`), true),
    linked: () => linked,
    save: (d) => (log.push(`save ${d.token}`), (linked = true)),
    revoke: async (t) => void log.push(`revoke ${t}`),
    sleep: () => tick(),
    ...over,
  };
  return { log, answers, deps, pairing: createPairing(deps) };
}

// W-145: the server hands the token out once, so polls never overlap and nothing can overtake that answer.
describe('linking this computer', () => {
  it('polls one at a time, and saves the token only after the user confirmed the account', async () => {
    const { log, answers, pairing } = setup();
    expect(await pairing.start()).toEqual({ userCode: 'CODE-1', pairId: 'p1' });
    await tick();
    expect(answers).toHaveLength(1);
    await tick();
    expect(answers).toHaveLength(1); // no second poll while the first is unanswered
    answers[0]({ status: 200, data: { status: 'pending' } });
    await tick();
    await tick();
    answers[1](approved('tok'));
    await tick();
    await tick();
    expect(log).toEqual(['poll p1', 'poll p1', 'confirm me@example.com', 'save tok']);
  });

  it('gives the token back when the user declines, or when the computer got linked meanwhile', async () => {
    for (const over of [{ confirm: async () => false }, { linked: () => true }]) {
      const { log, answers, pairing } = setup(over);
      await pairing.start();
      await tick();
      answers[0](approved('tok'));
      await tick();
      await tick();
      expect(log.at(-1)).toBe('revoke tok');
      expect(log).not.toContain('save tok');
    }
  });

  it('a newer attempt supersedes an older one: its delivery is given back, not saved', async () => {
    let release!: (ok: boolean) => void;
    const { log, answers, pairing } = setup({ confirm: () => new Promise((r) => (release = r)) });
    await pairing.start();
    await tick();
    answers[0](approved('old'));
    await tick();
    expect(pairing.confirming).toBe(true); // the page is told to answer the open question first
    await pairing.start(); // started again (the page can) while the first is being confirmed
    release(true);
    await tick();
    await tick();
    expect(log).toContain('revoke old');
    expect(log).not.toContain('save old');
    expect(pairing.confirming).toBe(false);
  });

  it('gives the token back when saving it here fails, or when linking was called off (Unlink)', async () => {
    const failing = setup({
      save: () => {
        throw new Error('keychain unavailable');
      },
    });
    await failing.pairing.start();
    await tick();
    failing.answers[0](approved('tok'));
    for (let i = 0; i < 4; i++) await tick();
    expect(failing.log.at(-1)).toBe('revoke tok');

    let release!: (ok: boolean) => void;
    const { log, answers, pairing } = setup({ confirm: () => new Promise((r) => (release = r)) });
    await pairing.start();
    await tick();
    answers[0](approved('tok2'));
    await tick();
    pairing.cancel();
    release(true);
    for (let i = 0; i < 4; i++) await tick();
    expect(log).toContain('revoke tok2');
    expect(log).not.toContain('save tok2');
  });

  it('keeps asking after an answer lost at the very end, while the server can still hand it out again (W-151)', async () => {
    let clock = 0;
    const replies: ({ status: number; data: PairAnswer } | null)[] = [
      ...Array.from({ length: 14 }, () => ({ status: 200, data: { status: 'pending' } })), // minutes 1–14
      null, // minute 15: approved and handed out on this request, but the answer was lost (a timeout)
      { status: 200, data: null as unknown as PairAnswer }, // minute 16: a body of `null`: no answer either
      approved('tok'), // minute 17: the same link again (the server re-delivers for 10 minutes)
    ];
    const { log, pairing } = setup({
      sleep: async () => {
        clock += 60_000;
        await tick();
      },
      now: () => clock,
      poll: async () => replies.shift() ?? null,
    });
    await pairing.start();
    for (let i = 0; i < 20; i++) await tick();
    expect(log).toEqual(['confirm me@example.com', 'save tok']);
  });

  it('stops polling an attempt once a newer one started', async () => {
    const { log, answers, pairing } = setup();
    await pairing.start();
    await tick();
    await pairing.start();
    answers[0]({ status: 200, data: { status: 'pending' } }); // the old attempt's last answer
    for (let i = 0; i < 6; i++) await tick();
    expect(log.filter((l) => l === 'poll p1')).toHaveLength(1);
    expect(log.filter((l) => l === 'poll p2').length).toBeGreaterThan(0);
  });
});
