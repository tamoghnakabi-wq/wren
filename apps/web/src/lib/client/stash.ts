// Drafts put aside with ⌘S / Ctrl+S in the composer, and brought back the same way in an empty box (the
// newest first). Kept in this browser only, under the signed-in account's own key, so another account on the
// same browser never gets them back; the files they name are the account's own uploads, which only it can
// open. At most MAX_DRAFTS, each for MAX_AGE_MS.

import { MAX_MESSAGE_CHARS } from './paste';
import type { Attachment } from './upload';

export interface Draft {
  text: string;
  files: Attachment[];
  /** It came from a prompt link, so the composer warns again when it comes back. */
  fromLink?: boolean;
  at: number;
}

export const MAX_DRAFTS = 20;
export const MAX_AGE_MS = 30 * 24 * 3_600_000;
/** Sent when the drafts change in this window (another window's change comes as a `storage` event). */
export const STASH_EVENT = 'wren:stash';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (userId: string) => `wren-stash:${userId}`;

function isAttachment(a: unknown): a is Attachment {
  const x = a as Attachment;
  return !!x && typeof x.artifactId === 'string' && typeof x.name === 'string' && typeof x.mime === 'string' && typeof x.size === 'number';
}

/** The drafts put aside, oldest first; anything that isn't one (or is too old) is dropped. */
export function readDrafts(store: Store, userId: string, now = Date.now()): Draft[] {
  try {
    const list = JSON.parse(store.getItem(key(userId)) ?? '[]') as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((d): d is Draft => !!d && typeof d.text === 'string' && typeof d.at === 'number' && Array.isArray(d.files) && d.files.every(isAttachment) && now - d.at < MAX_AGE_MS)
      .map((d) => ({ text: d.text.slice(0, MAX_MESSAGE_CHARS), files: d.files.slice(0, 10), ...(d.fromLink === true ? { fromLink: true } : {}), at: d.at }))
      .slice(-MAX_DRAFTS);
  } catch {
    return [];
  }
}

function write(store: Store, userId: string, drafts: Draft[]): void {
  if (drafts.length) store.setItem(key(userId), JSON.stringify(drafts.slice(-MAX_DRAFTS)));
  else store.removeItem(key(userId));
}

/** Puts a draft aside; returns how many there are now. Throws when the browser won't store it. */
export function putAside(store: Store, userId: string, draft: Omit<Draft, 'at'>, now = Date.now()): number {
  const drafts = [...readDrafts(store, userId, now), { ...draft, at: now }].slice(-MAX_DRAFTS);
  write(store, userId, drafts);
  return drafts.length;
}

/** The newest draft put aside, taken out, and how many are left; null when there's none. */
export function takeBack(store: Store, userId: string, now = Date.now()): { draft: Draft; left: number } | null {
  const drafts = readDrafts(store, userId, now);
  const draft = drafts.pop();
  if (!draft) return null;
  write(store, userId, drafts);
  return { draft, left: drafts.length };
}
