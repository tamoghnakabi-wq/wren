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
