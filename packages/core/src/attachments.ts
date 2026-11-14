import type { MessageData, SessionEvent } from './types';

// Files the user attaches reach the agent with the message: images as images (each model client and engine
// loads those), text files as text, added here to the message the model is given (nothing is saved). Before
// this, an agent got only the names of non-image files.

export type Attachment = NonNullable<MessageData['attachments']>[number];

/** Text files up to this size are read for the agent; a bigger one is named only. */
export const TEXT_FILE_MAX_BYTES = 1024 * 1024;
/** How much attached text one message passes on, its files together (about 25,000 tokens). */
export const ATTACHED_TEXT_MAX_CHARS = 100_000;
/** How much attached text a whole conversation passes on: the newest messages' files first. */
export const ATTACHED_TEXT_TOTAL_CHARS = 200_000;

const TEXT_TYPES = /^(text\/|application\/(json|ld\+json|x-ndjson|xml|yaml|x-yaml|toml|x-toml|javascript|typescript|x-sh|x-shellscript|sql|x-sql|csv|graphql|x-tex|x-subrip)$)/;
const TEXT_EXTENSIONS = new Set(
  (
    'txt text md markdown rst csv tsv json jsonl ndjson log yaml yml toml ini cfg conf xml html htm css scss js mjs cjs ts tsx jsx ' +
    'py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh fish sql graphql diff patch srt vtt tex r lua pl scala dart vue svelte'
  ).split(' '),
);

const extension = (name: string) => (name.includes('.') ? name.toLowerCase().split('.').pop()! : '');

const textLike = (a: Pick<Attachment, 'name' | 'mime'>) => TEXT_TYPES.test(a.mime.toLowerCase()) || TEXT_EXTENSIONS.has(extension(a.name));

/** Whether an attachment is a text file small enough to read for the agent (its bytes are checked too). */
export function isTextAttachment(a: Pick<Attachment, 'name' | 'mime' | 'size'>): boolean {
  return !a.mime.startsWith('image/') && a.size <= TEXT_FILE_MAX_BYTES && textLike(a);
}

/** The bytes as text, or null when they aren't UTF-8 text (a binary file with a text name or type). */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    return null;
  }
}

/** Reads an attached file's bytes (only the run's own account's files), or null when it can't. */
export type LoadAttachment = (artifactId: string) => Promise<Uint8Array | null>;

/** A loader that reads each file once (a run builds its transcript again for every model call). */
export function cachedLoader(load: LoadAttachment): LoadAttachment {
  const seen = new Map<string, Promise<Uint8Array | null>>();
  return (id) => {
    let p = seen.get(id);
    if (!p) {
      p = load(id).catch((e: unknown) => {
        seen.delete(id); // a Stop or lost lease ends this call; anything else may work next time
        throw e;
      });
      seen.set(id, p);
    }
    return p;
  };
}

const label = (name: string) => name.replace(/["\n\r<>]/g, "'").slice(0, 200);

/**
 * The text a user message gives the model with its attached files: each text file's contents (within
 * `budget` characters), and a note for each file it doesn't get, so the agent doesn't guess at what's in it.
 * Returns the text and how much of the budget it used. Errors other than a Stop (`signal`) only skip that file.
 */
export async function attachedText(d: MessageData, load: LoadAttachment, budget: number, signal?: AbortSignal): Promise<{ text: string; used: number }> {
  const files = (d.attachments ?? []).filter((a) => !a.mime.startsWith('image/'));
  if (!files.length) return { text: d.text ?? '', used: 0 };
  let left = Math.min(budget, ATTACHED_TEXT_MAX_CHARS);
  const parts: string[] = [];
  const notes: string[] = [];
  for (const a of files) {
    const name = label(a.name);
    if (!isTextAttachment(a)) {
      notes.push(`${name} (${textLike(a) ? 'over 1 MB' : 'not a text file'})`);
      continue;
    }
    if (left <= 0) {
      notes.push(`${name} (left out to keep the conversation short; ask the user for the part you need)`);
      continue;
    }
    let bytes: Uint8Array | null = null;
    try {
      bytes = await load(a.artifactId);
    } catch (e) {
      if (signal?.aborted || (e as { status?: number }).status === 409) throw e;
    }
    const text = bytes ? decodeText(bytes) : null;
    if (text === null) {
      notes.push(`${name} (${bytes ? 'not a text file' : 'it couldn’t be loaded'})`);
      continue;
    }
    const kept = text.slice(0, left);
    left -= kept.length;
    const cut = kept.length < text.length ? `\n[Cut here: ${name} has ${text.length.toLocaleString('en-US')} characters and only the first ${kept.length.toLocaleString('en-US')} are included.]` : '';
    parts.push(`<attached-file name="${name}">\n${kept}${cut}\n</attached-file>`);
  }
  const used = Math.min(budget, ATTACHED_TEXT_MAX_CHARS) - left;
  const note = notes.length ? `[Wren can't give you the contents of: ${notes.join('; ')}.]` : '';
  return { text: [d.text ?? '', ...parts, note].filter(Boolean).join('\n\n'), used };
}

/**
 * The conversation as the model is given it: user messages with attached files get those files' text
 * (copies; nothing is saved). The newest messages' files come first within ATTACHED_TEXT_TOTAL_CHARS.
 */
export async function withAttachedText(events: SessionEvent[], load: LoadAttachment, signal?: AbortSignal): Promise<SessionEvent[]> {
  const out = [...events];
  let budget = ATTACHED_TEXT_TOTAL_CHARS;
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i];
    const d = e.data as MessageData;
    if (e.type !== 'message' || d.role !== 'user' || !d.attachments?.some((a) => !a.mime.startsWith('image/'))) continue;
    const r = await attachedText(d, load, budget, signal);
    budget -= r.used;
    out[i] = { ...e, data: { ...d, text: r.text } };
  }
  return out;
}
