// Searching tasks (POST /api/search and the ⌘K palette). Plain module: the browser highlights with the same
// words the server searched for.

/** Longest query looked at. */
export const MAX_QUERY = 200;
/** Words searched for at most. */
export const MAX_WORDS = 8;

/**
 * The words of a query: runs of letters and digits, lower case, each once. Anything else (quotes, operators,
 * punctuation) only separates words, so nothing the user types can change how the database reads the query.
 * One-letter words go unless they're all there is (they would match nearly everything as a prefix).
 */
export function searchWords(q: string): string[] {
  const all = [...new Set((q.slice(0, MAX_QUERY).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []))];
  const long = all.filter((w) => w.length > 1 || /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(w));
  return (long.length ? long : all).slice(0, MAX_WORDS);
}

/** Words in quotes, which must come together and in this order. */
export interface Phrase {
  words: string[];
  /** The quote isn't closed yet (it's still being typed), so its last word may be the start of one. */
  open: boolean;
}
/** Phrases looked for at most. */
export const MAX_PHRASES = 3;

/**
 * The quoted phrases of a query ("deploy the api"), each as its words (the same runs of letters and digits as
 * `searchWords`, one-letter ones kept: they hold the others apart). A quote needs two words to be a phrase.
 */
export function searchPhrases(q: string): Phrase[] {
  const s = q.slice(0, MAX_QUERY).toLowerCase().replace(/[“”„‟«»]/g, '"');
  const out: Phrase[] = [];
  for (const m of s.matchAll(/"([^"]*)("|$)/g)) {
    const words = (m[1].match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_WORDS);
    if (words.length >= 2) out.push({ words, open: !m[2] });
    if (out.length >= MAX_PHRASES) break;
  }
  return out;
}

/**
 * A message matches when it has every word, and each phrase's words next to each other in order (`<->`).
 * The word still being typed also matches as the start of a longer word ("deplo" finds "deploy") once it
 * has three characters (a shorter prefix would match most of the index): the last loose word, or the last
 * word of a phrase whose quote isn't closed yet.
 */
export function tsQuery(words: string[], phrases: Phrase[] = []): string {
  const prefix = (w: string, last: boolean) => (last && w.length >= 3 ? `${w}:*` : w);
  const typing = phrases.some((p) => p.open);
  const inPhrase = new Set(phrases.flatMap((p) => p.words));
  const loose = words.filter((w) => !inPhrase.has(w));
  return [
    ...phrases.map((p) => `(${p.words.map((w, i) => prefix(w, p.open && i === p.words.length - 1)).join(' <-> ')})`),
    ...loose.map((w, i) => prefix(w, !typing && i === loose.length - 1)),
  ].join(' & ');
}

/** A POSIX pattern (`~*`) for a title holding a phrase: its words with only spaces or punctuation between. */
export function phrasePattern(p: Phrase): string {
  return p.words.join('[^[:alnum:]]+');
}

/** Whether a query is worth sending to the database for messages: at least one word of two or more characters. */
export function searchableInMessages(words: string[]): boolean {
  return words.some((w) => w.length >= 2);
}

/** The same expression as the events_message_words index (migration 0016), as SQL text for documentation and tests. */
export const MESSAGE_WORDS_SQL = "to_tsvector('simple'::regconfig, left(coalesce(data->>'text', ''), 100000))";

/** `%` and `_` (and the escape character) taken literally in an ILIKE pattern. */
export function likePattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * A short piece of a message around the first place one of the words starts, on word boundaries, with "…"
 * where it was cut. Whitespace runs become single spaces.
 */
export function snippet(text: string, words: string[], before = 50, after = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const lower = flat.toLowerCase();
  let at = -1;
  for (const w of words) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}`, 'u');
    const m = re.exec(lower);
    if (m && (at < 0 || m.index + m[1].length < at)) at = m.index + m[1].length;
  }
  if (at < 0) at = 0;
  let start = Math.max(0, at - before);
  let end = Math.min(flat.length, at + after);
  if (start > 0) {
    const space = flat.indexOf(' ', start);
    if (space >= 0 && space < at) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end);
    if (space > at) end = space;
  }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** Splits text into pieces, marking those that start one of the words (for highlighting). */
export function markWords(text: string, words: string[]): { text: string; hit: boolean }[] {
  if (!words.length || !text) return [{ text, hit: false }];
  const alt = [...words].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})`, 'giu');
  const out: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface SearchTask {
  id: string;
  title: string;
  agentId: string;
  status: string;
  archived: boolean;
  at: string;
}

export interface SearchMessage extends SearchTask {
  /** The message's place in the task (`?at=` opens the task there). */
  seq: number;
  role: 'user' | 'assistant';
  snippet: string;
}

export interface SearchResult {
  words: string[];
  tasks: SearchTask[];
  messages: SearchMessage[];
}
