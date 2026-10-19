// Finishing an authenticator-app setup (Settings → Security), kept apart from the dialog so tests can
// drive it with stand-ins (W-189). The order: check the code; turn email codes off only while the
// new app is verified and still there (read from Supabase right before); create the first recovery
// codes; then report what Supabase and the server say now, not what the steps hoped for. Closing the
// dialog is refused while this runs, and removes the new app only if it was never verified.
// Each step gets its own deadline (W-192), so the dialog can't stay locked: past it, Wren stops
// waiting, ignores that step's answer whenever it comes, runs nothing after it, and says the outcome
// must be checked. A code check that ran out may still have gone through, so the app is then treated
// as verified (closing keeps it) and email codes are left as they are.

/** How long each step may take before Wren stops waiting for it. */
export const STEP_TIMEOUT_MS = 20_000;

/** Each step settles by itself, without waiting on the user: one that takes over the deadline is given up on. */
export interface EnrollSteps {
  /** Check the code against the new app (Supabase challenge + verify). Rejects with a message for the user. */
  verify(factorId: string, code: string): Promise<void>;
  /** Ids of the account's verified authenticator apps, read from Supabase now. */
  verifiedFactors(): Promise<string[]>;
  /** Turn email codes off (Wren's API). */
  emailOff(): Promise<void>;
  /** Whether email codes are on, as the server says now. */
  emailOn(): Promise<boolean>;
  /** Create the account's first recovery codes. Rejects with a message for the user. */
  createRecoveryCodes(): Promise<string[]>;
  /** Remove an enrollment that was never finished. */
  discard(factorId: string): Promise<void>;
  notify(text: string, tone: 'success' | 'error'): void;
}

export interface EnrollSetup {
  /** Email codes were on when setup started: they give way to the app once it's in place. */
  email: boolean;
  /** The account's first app, with no recovery codes yet: it gets recovery codes. */
  firstApp: boolean;
}

export type CommitResult =
  /** The code wasn't accepted: show why and let the user try again. */
  | { status: 'retry'; error: string }
  /** Finished and reported: close the dialog, then show these recovery codes, if any. */
  | { status: 'done'; codes: string[] | null }
  /** The dialog went away meanwhile, so the later steps didn't run. */
  | { status: 'stopped' }
  /** A step ran out of time: Wren stopped waiting, nothing after it ran, and the user was told the
   * outcome is unknown. Close the dialog and re-read the settings. */
  | { status: 'timeout' }
  /** Nothing to do: no enrollment yet, already running, already verified or closed. */
  | { status: 'ignored' };

export interface EnrollFlow {
  /** Setup is committing: the dialog must stay open. */
  readonly committing: boolean;
  /** The enrollment Supabase made. False if the dialog was closed meanwhile (it's removed again). */
  enrolled(factorId: string): boolean;
  commit(code: string): Promise<CommitResult>;
  /** The user dismissed the dialog. Refused (false) while committing. */
  close(): boolean;
  /** The dialog went away without being closed (unmounted): a running commit stops before its next step. */
  detach(): void;
}

export const SETUP_DONE = 'Two-step sign-in is on.';
export const EMAIL_STILL_ON = 'Authenticator app added, but email codes are still on, so signing in still asks for an email code. Turn them off below.';
export const UNCHECKED = 'Authenticator app added, but Wren couldn’t confirm that setup finished. Check the settings below.';
export const codesFailed = (why: string) => `Authenticator app added, but recovery codes couldn’t be created: ${why}`;
/** The code check ran out of time: it may or may not have gone through. */
export const VERIFY_TIMED_OUT = 'Setup is taking too long. Wren stopped waiting; check the settings below to see whether the authenticator app was added.';
/** A step after the code was accepted ran out of time: email codes or recovery codes may not be done. */
export const FINISH_TIMED_OUT = 'Authenticator app added, but finishing setup is taking too long, so Wren stopped waiting. Check the settings below.';
/** The new app was removed (another tab or device) before setup finished; `email` and `apps` are as read just now. */
export function appGone(email: boolean | null, apps: number): string {
  const now = email ? ' Email codes are still on.' : email === false && apps === 0 ? ' Signing in only needs your password now.' : '';
  return `The new authenticator app was removed before setup finished.${now}`;
}

const reason = (e: unknown) => (e instanceof Error && e.message) || 'Something went wrong. Try again.';

/** A step didn't settle within its deadline. */
class TooSlow extends Error {}

/** `p`, or a TooSlow rejection once `ms` have passed. If `p` settles later, nothing waits for it (and its error isn't left unhandled). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TooSlow()), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export function enrollFlow(steps: EnrollSteps, setup: EnrollSetup, { stepMs = STEP_TIMEOUT_MS }: { stepMs?: number } = {}): EnrollFlow {
  let factorId: string | null = null;
  // Read when the dialog closes, however late: from here on closing never removes the app. Also set
  // when the code check ran out of time, since it may have gone through.
  let verified = false;
  let committing = false;
  let closed = false;
  // Bumped when the dialog goes away; a commit checks it before each step.
  let generation = 0;

  // A leftover that couldn't be removed is cleared when setup next starts.
  const discard = (id: string) => void steps.discard(id).catch(() => {});

  return {
    get committing() {
      return committing;
    },

    enrolled(id) {
      if (factorId === id) return !closed;
      factorId = id;
      if (closed) discard(id); // closed while Supabase was still making it
      return !closed;
    },

    close() {
      if (committing) return false;
      if (!closed) {
        closed = true;
        generation++;
        if (factorId && !verified) discard(factorId); // not finished: don't leave it behind
      }
      return true;
    },

    detach() {
      generation++;
    },

    async commit(code) {
      if (!factorId || committing || closed || verified) return { status: 'ignored' };
      const id = factorId;
      const mine = generation;
      const live = () => generation === mine;
      const step = <T>(p: Promise<T>) => within(p, stepMs);
      // A step ran out of time: stop waiting. Nothing after it runs, and its answer, whenever it
      // comes, finds a new generation.
      const giveUp = (text: string): CommitResult => {
        if (!live()) return { status: 'stopped' };
        generation++;
        steps.notify(text, 'error');
        return { status: 'timeout' };
      };
      committing = true;
      try {
        try {
          await step(steps.verify(id, code));
        } catch (e) {
          if (!(e instanceof TooSlow)) return { status: 'retry', error: reason(e) };
          // Not a wrong code: it may have gone through. Closing keeps the app (one left unfinished
          // is cleared when setup next starts), and email codes stay as they are.
          verified = true;
          return giveUp(VERIFY_TIMED_OUT);
        }
        verified = true;
        if (!live()) return { status: 'stopped' };

        // Another tab may have removed the app meanwhile. Email codes give way only to an app that's
        // confirmed there: if it's gone, or this can't be read, they stay on.
        const before = await step(steps.verifiedFactors().catch(() => null));
        if (!live()) return { status: 'stopped' };
        const present = before ? before.includes(id) : null;
        if (setup.email && present === true) {
          await step(steps.emailOff().catch(() => {})); // if they're still on, the report below says so
          if (!live()) return { status: 'stopped' };
        }

        let codes: string[] | null = null;
        let codesError: string | null = null;
        if (setup.firstApp && present !== false) {
          try {
            codes = await step(steps.createRecoveryCodes());
          } catch (e) {
            if (e instanceof TooSlow) throw e;
            codesError = reason(e);
          }
          if (!live()) return { status: 'stopped' };
        }

        // Say what is true now. A read that fails or runs out of time is unknown, and the report
        // says so; recovery codes made just now are still handed over (they're shown only once).
        const read = <T>(p: Promise<T>) => step(p).catch(() => null);
        const [apps, emailNow] = await Promise.all([read(steps.verifiedFactors()), read(steps.emailOn())]);
        if (!live()) return { status: 'stopped' };
        if (apps && !apps.includes(id)) {
          // Its recovery codes went with it if it was the last one (migration 0010).
          steps.notify(appGone(emailNow, apps.length), 'error');
          return { status: 'done', codes: null };
        }
        if (codesError) steps.notify(codesFailed(codesError), 'error');
        if (!apps || emailNow === null) steps.notify(UNCHECKED, 'error');
        else if (emailNow) steps.notify(EMAIL_STILL_ON, 'error');
        else steps.notify(SETUP_DONE, 'success');
        return { status: 'done', codes };
      } catch (e) {
        if (e instanceof TooSlow) return giveUp(FINISH_TIMED_OUT);
        throw e;
      } finally {
        committing = false;
      }
    },
  };
}
