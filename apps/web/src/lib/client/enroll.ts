// Finishing an authenticator-app setup (Settings → Security), kept apart from the dialog so tests can
// drive it with stand-ins (W-189). The order: check the code; turn email codes off only while the
// new app is verified and still there (read from Supabase right before); create the first recovery
// codes; then report what Supabase and the server say now, not what the steps hoped for. Closing the
// dialog is refused while this runs, and removes the new app only if it was never verified.

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
/** The new app was removed (another tab or device) before setup finished; `email` and `apps` are as read just now. */
export function appGone(email: boolean | null, apps: number): string {
  const now = email ? ' Email codes are still on.' : email === false && apps === 0 ? ' Signing in only needs your password now.' : '';
  return `The new authenticator app was removed before setup finished.${now}`;
}

const reason = (e: unknown) => (e instanceof Error && e.message) || 'Something went wrong. Try again.';

export function enrollFlow(steps: EnrollSteps, setup: EnrollSetup): EnrollFlow {
  let factorId: string | null = null;
  // Read when the dialog closes, however late: from here on closing never removes the app.
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
      committing = true;
      try {
        try {
          await steps.verify(id, code);
        } catch (e) {
          return { status: 'retry', error: reason(e) };
        }
        verified = true;
        if (!live()) return { status: 'stopped' };

        // Another tab may have removed the app meanwhile. Email codes give way only to an app that's
        // confirmed there: if it's gone, or this can't be read, they stay on.
        const before = await steps.verifiedFactors().catch(() => null);
        if (!live()) return { status: 'stopped' };
        const present = before ? before.includes(id) : null;
        if (setup.email && present === true) {
          await steps.emailOff().catch(() => {}); // if they're still on, the report below says so
          if (!live()) return { status: 'stopped' };
        }

        let codes: string[] | null = null;
        let codesError: string | null = null;
        if (setup.firstApp && present !== false) {
          try {
            codes = await steps.createRecoveryCodes();
          } catch (e) {
            codesError = reason(e);
          }
          if (!live()) return { status: 'stopped' };
        }

        // Say what is true now.
        const [apps, emailNow] = await Promise.all([steps.verifiedFactors().catch(() => null), steps.emailOn().catch(() => null)]);
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
      } finally {
        committing = false;
      }
    },
  };
}
