// The Usage page's days are calendar days in the account's time zone (Settings → Time zone), so its
// last bar is the user's own today. A day travels as "YYYY-MM-DD": a date, not an instant. It is shown
// as written, never moved into the viewer's zone (new Date('2026-11-08') is midnight UTC, which is
// still Nov 7 anywhere west of UTC, so every bar was labelled a day early there).

/** How many days the Usage page shows, today included. */
export const USAGE_DAYS = 30;

/** "Nov 8" for "2026-11-08", whatever the viewer's time zone. */
export function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });
}

/** The last `n` days up to today in `timeZone` (the browser's own if not given), oldest first. */
export function lastDays(n: number, timeZone?: string, now = Date.now()): string[] {
  // en-CA writes dates as YYYY-MM-DD.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const midnight = Date.parse(`${today}T00:00:00Z`);
  // Counted back in UTC, where every day is 24 hours long (no daylight-saving jumps).
  return Array.from({ length: n }, (_, i) => new Date(midnight - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}
