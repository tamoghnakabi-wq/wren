import { describe, expect, it } from 'vitest';
import { MAX_AGE_MS, MAX_DRAFTS, putAside, readDrafts, takeBack } from '../src/lib/client/stash';

// ⌘S in the composer: drafts put aside in this browser, per account, the newest back first.

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const file = { artifactId: 'f1', name: 'notes.txt', mime: 'text/plain', size: 5 };

describe('drafts put aside', () => {
  it('brings back the newest first, and only to the same account', () => {
    const s = store();
    expect(putAside(s, 'u1', { text: 'first', files: [] }, 1000)).toBe(1);
    expect(putAside(s, 'u1', { text: 'second', files: [file], fromLink: true }, 2000)).toBe(2);
    expect(takeBack(s, 'u2', 3000)).toBeNull();
    expect(takeBack(s, 'u1', 3000)).toEqual({ draft: { text: 'second', files: [file], fromLink: true, at: 2000 }, left: 1 });
    expect(takeBack(s, 'u1', 3000)).toEqual({ draft: { text: 'first', files: [], at: 1000 }, left: 0 });
    expect(takeBack(s, 'u1', 3000)).toBeNull();
    expect(s.m.size).toBe(0);
  });

  it('keeps the newest few, for a month, and ignores anything else in the slot', () => {
    const s = store();
    for (let i = 0; i < MAX_DRAFTS + 5; i++) putAside(s, 'u1', { text: `d${i}`, files: [] }, 1000 + i);
    const kept = readDrafts(s, 'u1', 2000);
    expect(kept).toHaveLength(MAX_DRAFTS);
    expect(kept[0].text).toBe('d5');
    expect(readDrafts(s, 'u1', 1030 + MAX_AGE_MS)).toEqual([]);
    s.setItem('wren-stash:u3', JSON.stringify([{ text: 'ok', files: [], at: 5 }, { text: 1 }, { text: 'bad file', files: [{ name: 'x' }], at: 5 }, null]));
    expect(readDrafts(s, 'u3', 10).map((d) => d.text)).toEqual(['ok']);
    s.setItem('wren-stash:u4', '{not json');
    expect(readDrafts(s, 'u4')).toEqual([]);
  });
});
