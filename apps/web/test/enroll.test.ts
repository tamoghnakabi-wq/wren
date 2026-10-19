import { afterEach, describe, expect, it, vi } from 'vitest';
import { appGone, EMAIL_STILL_ON, enrollFlow, FINISH_TIMED_OUT, SETUP_DONE, STEP_TIMEOUT_MS, UNCHECKED, VERIFY_TIMED_OUT, type CommitResult, type EnrollSteps } from '../src/lib/client/enroll';

// W-189: finishing an authenticator-app setup, against a stand-in account (Supabase's factors, Wren's
// email-code switch). A step can be held open to act while it's pending, as a user closing the
// dialog or another tab removing the app would.
function account({ email = true, firstApp = true, stepMs = undefined as number | undefined, change = {} as Partial<EnrollSteps> } = {}) {
  const state = { factors: new Map<string, 'unverified' | 'verified'>([['f1', 'unverified']]), email, recoveryCodes: false };
  const log: string[] = [];
  const notices: { text: string; tone: string }[] = [];
  const held = new Map<string, Promise<void>>();
  const after = new Map<string, () => void>();
  const step = async (name: string) => {
    log.push(name);
    await held.get(name);
  };
  const verified = () => [...state.factors].filter(([, s]) => s === 'verified').map(([id]) => id);
  const steps: EnrollSteps = {
    async verify(id, code) {
      await step('verify');
      if (code !== '123456') throw new Error('That code isn’t right. Check it and try again.');
      if (state.factors.has(id)) state.factors.set(id, 'verified');
      after.get('verify')?.();
    },
    async verifiedFactors() {
      await step('factors');
      return verified();
    },
    async emailOff() {
      await step('emailOff');
      state.email = false;
    },
    async emailOn() {
      await step('emailOn');
      return state.email;
    },
    async createRecoveryCodes() {
      await step('recoveryCodes');
      if (!verified().length) throw new Error('No verified factor remains');
      state.recoveryCodes = true;
      return ['aaaabbbbccccdddd'];
    },
    async discard(id) {
      log.push(`discard ${id}`);
      state.factors.delete(id);
      if (!verified().length) state.recoveryCodes = false; // the database trigger (migration 0010)
    },
    notify(text, tone) {
      log.push(`notify ${tone}`);
      notices.push({ text, tone });
    },
    ...change,
  };
  /** Hold `name` open until the returned function is called. */
  const hold = (name: string) => {
    let release = () => {};
    held.set(name, new Promise<void>((r) => (release = r)));
    return () => {
      held.delete(name);
      release();
    };
  };
  const flow = enrollFlow(steps, { email, firstApp }, { stepMs });
  /** Signing in still asks for something beyond the password. */
  const protectedNow = () => state.email || verified().length > 0;
  return { state, log, notices, hold, after, flow, protectedNow };
}

const discarded = (log: string[]) => log.filter((l) => l.startsWith('discard'));

/** Let `ms` of fake time pass; then the commit's result, or undefined while it's still running. */
async function after(ms: number, commit: Promise<CommitResult>) {
  const out: { result?: CommitResult } = {};
  void commit.then((r) => (out.result = r));
  await vi.advanceTimersByTimeAsync(ms);
  return out.result;
}

afterEach(() => vi.useRealTimers());

describe('authenticator setup (W-189)', () => {
  it('closing before the code is checked removes the unfinished app', () => {
    const a = account();
    a.flow.enrolled('f1');
    expect(a.flow.close()).toBe(true);
    expect(a.log).toEqual(['discard f1']);
    expect(a.state.factors.size).toBe(0);
    expect(a.state.email).toBe(true);
  });

  it('closing after a wrong code removes it too, and nothing else changes', async () => {
    const a = account();
    a.flow.enrolled('f1');
    expect(await a.flow.commit('000000')).toEqual({ status: 'retry', error: 'That code isn’t right. Check it and try again.' });
    expect(a.flow.close()).toBe(true);
    expect(a.log).toEqual(['verify', 'discard f1']);
    expect(a.state.email).toBe(true);
    expect(a.notices).toEqual([]);
  });

  it('refuses to close while committing, and never removes a verified app', async () => {
    // The auditor's trace: email codes on, no authenticator yet; the user closes the dialog while
    // the request turning email codes off is pending.
    const a = account();
    a.flow.enrolled('f1');
    const releaseVerify = a.hold('verify');
    const releaseEmail = a.hold('emailOff');
    const done = a.flow.commit('123456');
    expect(a.flow.committing).toBe(true);
    expect(a.flow.close()).toBe(false); // while the code is being checked
    releaseVerify();
    await vi.waitFor(() => expect(a.log).toContain('emailOff'));
    expect(a.flow.close()).toBe(false); // while email codes are being turned off
    expect(discarded(a.log)).toEqual([]);
    releaseEmail();
    expect(await done).toEqual({ status: 'done', codes: ['aaaabbbbccccdddd'] });
    expect(a.state.factors.get('f1')).toBe('verified');
    expect(a.state).toMatchObject({ email: false, recoveryCodes: true });
    expect(a.notices).toEqual([{ text: SETUP_DONE, tone: 'success' }]);
    // Closing once it's finished keeps the app.
    expect(a.flow.close()).toBe(true);
    expect(discarded(a.log)).toEqual([]);
    expect(a.protectedNow()).toBe(true);
  });

  it('leaves email codes on when the new app is gone before they would be turned off', async () => {
    const a = account();
    a.flow.enrolled('f1');
    a.after.set('verify', () => a.state.factors.delete('f1')); // removed in another tab right after
    expect(await a.flow.commit('123456')).toEqual({ status: 'done', codes: null });
    expect(a.log).not.toContain('emailOff');
    expect(a.log).not.toContain('recoveryCodes');
    expect(a.state.email).toBe(true);
    expect(a.notices).toEqual([{ text: appGone(true, 0), tone: 'error' }]);
    expect(a.protectedNow()).toBe(true);
  });

  it('leaves email codes on when it can’t confirm the new app is there', async () => {
    let reads = 0;
    const a = account({
      change: {
        // The read before turning email codes off fails; the one at the end works.
        verifiedFactors: async () => {
          if (reads++ === 0) throw new Error('offline');
          return ['f1'];
        },
      },
    });
    a.flow.enrolled('f1');
    expect(await a.flow.commit('123456')).toEqual({ status: 'done', codes: ['aaaabbbbccccdddd'] });
    expect(a.log).not.toContain('emailOff');
    expect(a.state.email).toBe(true);
    expect(a.notices).toEqual([{ text: EMAIL_STILL_ON, tone: 'error' }]);
  });

  it('turns email codes off, creates recovery codes, and says it’s on only after reading it back', async () => {
    const a = account();
    a.flow.enrolled('f1');
    expect(await a.flow.commit('123456')).toEqual({ status: 'done', codes: ['aaaabbbbccccdddd'] });
    expect(a.log).toEqual(['verify', 'factors', 'emailOff', 'recoveryCodes', 'factors', 'emailOn', 'notify success']);
    expect(a.state).toMatchObject({ email: false, recoveryCodes: true });
    expect(a.notices).toEqual([{ text: SETUP_DONE, tone: 'success' }]);
  });

  it('says email codes are still on when turning them off didn’t take', async () => {
    const a = account({
      firstApp: false,
      change: {
        emailOff: async () => {
          throw new Error('Confirm it’s you first.');
        },
      },
    });
    a.flow.enrolled('f1');
    expect(await a.flow.commit('123456')).toEqual({ status: 'done', codes: null });
    expect(a.state.email).toBe(true);
    expect(a.notices).toEqual([{ text: EMAIL_STILL_ON, tone: 'error' }]);
  });

  it('says it couldn’t check when the final read fails, instead of claiming success', async () => {
    const a = account({
      email: false,
      firstApp: false,
      change: {
        emailOn: async () => {
          throw new Error('offline');
        },
      },
    });
    a.flow.enrolled('f1');
    expect(await a.flow.commit('123456')).toEqual({ status: 'done', codes: null });
    expect(a.notices).toEqual([{ text: UNCHECKED, tone: 'error' }]);
  });

  it('stops before the next step when the dialog goes away mid-commit', async () => {
    const a = account();
    a.flow.enrolled('f1');
    const release = a.hold('verify');
    const done = a.flow.commit('123456');
    a.flow.detach(); // unmounted (the page changed)
    release();
    expect(await done).toEqual({ status: 'stopped' });
    expect(a.log).toEqual(['verify']);
    expect(a.state.factors.get('f1')).toBe('verified');
    expect(a.state.email).toBe(true); // nothing turned off: signing in still asks for an email code
    expect(a.notices).toEqual([]);
  });

  it('removes an enrollment that arrives after the dialog was closed', () => {
    const a = account();
    expect(a.flow.close()).toBe(true);
    expect(a.flow.enrolled('f1')).toBe(false);
    expect(a.flow.enrolled('f1')).toBe(false); // React's development mode delivers it twice
    expect(a.log).toEqual(['discard f1']);
  });
});

// W-192: each step has a deadline, so a request that never answers can't keep the dialog locked.
describe('authenticator setup that stops answering (W-192)', () => {
  it('stops waiting for a code check: unlocks, says the outcome is unknown, keeps the app and ignores the late answer', async () => {
    vi.useFakeTimers();
    const a = account();
    a.flow.enrolled('f1');
    const release = a.hold('verify');
    const done = a.flow.commit('123456');
    expect(await after(STEP_TIMEOUT_MS - 1, done)).toBeUndefined();
    expect(a.flow.close()).toBe(false); // still refused while the check may yet answer
    expect(await after(1, done)).toEqual({ status: 'timeout' }); // not a wrong-code retry
    expect(a.flow.committing).toBe(false);
    expect(a.notices).toEqual([{ text: VERIFY_TIMED_OUT, tone: 'error' }]);
    // The dialog can be closed now, and that doesn't remove an app whose code may have gone through.
    expect(a.flow.close()).toBe(true);
    expect(discarded(a.log)).toEqual([]);
    // The code did go through, late: nothing follows from it.
    release();
    await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS * 5);
    expect(a.state.factors.get('f1')).toBe('verified');
    expect(a.log).toEqual(['verify', 'notify error']);
    expect(a.state).toMatchObject({ email: true, recoveryCodes: false }); // email codes never turned off
    expect(a.notices).toHaveLength(1);
    expect(await a.flow.commit('123456')).toEqual({ status: 'ignored' });
    expect(a.protectedNow()).toBe(true);
  });

  it('says it couldn’t check, not that setup is done, when the final read doesn’t answer', async () => {
    vi.useFakeTimers();
    const a = account();
    a.flow.enrolled('f1');
    const release = a.hold('emailOn');
    const done = a.flow.commit('123456');
    expect(await after(STEP_TIMEOUT_MS - 1, done)).toBeUndefined();
    // The recovery codes made just before are still handed over: they're shown only once.
    expect(await after(1, done)).toEqual({ status: 'done', codes: ['aaaabbbbccccdddd'] });
    expect(a.flow.committing).toBe(false);
    expect(a.notices).toEqual([{ text: UNCHECKED, tone: 'error' }]);
    release();
    await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS);
    expect(a.notices).toEqual([{ text: UNCHECKED, tone: 'error' }]); // the late answer says nothing
    expect(a.flow.close()).toBe(true);
    expect(discarded(a.log)).toEqual([]);
  });

  it('runs nothing after a step that ran out of time, even once it answers', async () => {
    vi.useFakeTimers();
    const a = account({ stepMs: 5_000 }); // the deadline can be set
    a.flow.enrolled('f1');
    const release = a.hold('emailOff');
    const done = a.flow.commit('123456');
    expect(await after(4_999, done)).toBeUndefined();
    expect(a.flow.close()).toBe(false);
    expect(await after(1, done)).toEqual({ status: 'timeout' });
    expect(a.notices).toEqual([{ text: FINISH_TIMED_OUT, tone: 'error' }]);
    release(); // email codes go off after all
    await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS);
    expect(a.log).toEqual(['verify', 'factors', 'emailOff', 'notify error']); // no recovery codes, no report
    expect(a.state).toMatchObject({ email: false, recoveryCodes: false });
    expect(a.state.factors.get('f1')).toBe('verified');
    expect(a.protectedNow()).toBe(true);
    expect(a.flow.close()).toBe(true);
    expect(discarded(a.log)).toEqual([]);
  });

  it('says nothing when the dialog went away before a step ran out of time', async () => {
    vi.useFakeTimers();
    const a = account();
    a.flow.enrolled('f1');
    a.hold('verify');
    const done = a.flow.commit('123456');
    a.flow.detach(); // unmounted (the page changed)
    expect(await after(STEP_TIMEOUT_MS, done)).toEqual({ status: 'stopped' });
    expect(a.notices).toEqual([]);
  });

  it('gives each step its own deadline: a slow setup that keeps answering finishes as before', async () => {
    vi.useFakeTimers();
    const a = account();
    a.flow.enrolled('f1');
    const releaseVerify = a.hold('verify');
    const releaseEmail = a.hold('emailOff');
    const done = a.flow.commit('123456');
    expect(await after(STEP_TIMEOUT_MS - 1_000, done)).toBeUndefined();
    releaseVerify();
    expect(await after(STEP_TIMEOUT_MS - 1_000, done)).toBeUndefined(); // longer than one deadline in all
    expect(a.flow.close()).toBe(false);
    releaseEmail();
    expect(await after(0, done)).toEqual({ status: 'done', codes: ['aaaabbbbccccdddd'] });
    expect(a.log).toEqual(['verify', 'factors', 'emailOff', 'recoveryCodes', 'factors', 'emailOn', 'notify success']);
    expect(a.state).toMatchObject({ email: false, recoveryCodes: true });
    expect(a.notices).toEqual([{ text: SETUP_DONE, tone: 'success' }]);
    expect(vi.getTimerCount()).toBe(0); // every deadline was cleared
  });
});
