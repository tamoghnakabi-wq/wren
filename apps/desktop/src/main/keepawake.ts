/** The part of Electron's powerSaveBlocker this uses (a stand-in in tests). */
export interface SleepBlocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

/** How long the computer stays awake after the last task here ends, so a follow-up doesn't find it asleep. */
export const AWAKE_GRACE_MS = 60_000;

/**
 * Keeps the computer from going to sleep while agents work on it (the screen can still turn off), and for a
 * minute after the last task ends. Closing a laptop's lid can still put it to sleep: no app can stop that.
 */
export class KeepAwake {
  private id: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly blocker: SleepBlocker,
    private readonly graceMs = AWAKE_GRACE_MS,
  ) {}

  /** `busy`: tasks are running on this computer. `wanted`: the setting ("Stay awake while agents work"). */
  update(busy: boolean, wanted: boolean): void {
    if (!wanted) return this.stop();
    if (busy) {
      this.clearTimer();
      if (this.id === null || !this.blocker.isStarted(this.id)) this.id = this.blocker.start('prevent-app-suspension');
      return;
    }
    if (this.id === null || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.release();
    }, this.graceMs);
    this.timer.unref?.();
  }

  /** Lets the computer sleep again at once (the setting turned off, or Wren quitting). */
  stop(): void {
    this.clearTimer();
    this.release();
  }

  get holding(): boolean {
    return this.id !== null;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private release() {
    if (this.id === null) return;
    try {
      this.blocker.stop(this.id);
    } catch {
      /* nothing held any more */
    }
    this.id = null;
  }
}
