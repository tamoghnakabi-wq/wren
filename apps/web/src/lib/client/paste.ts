/** The longest message `/api/tasks` takes. */
export const MAX_MESSAGE_CHARS = 20_000;
/** A paste longer than this is attached as a text file instead (agents get its text; the timeline stays short). */
export const PASTE_AS_FILE_CHARS = 10_000;
/** Agents read attached text files up to 1 MB (core TEXT_FILE_MAX_BYTES). */
export const READABLE_TEXT_BYTES = 1024 * 1024;

/** The next free "Pasted text N.txt" name among the files already attached. */
export function pastedFileName(taken: string[]): string {
  for (let n = 1; ; n++) if (!taken.includes(`Pasted text ${n}.txt`)) return `Pasted text ${n}.txt`;
}
