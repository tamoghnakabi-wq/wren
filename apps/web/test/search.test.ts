import { describe, expect, it } from 'vitest';
import { likePattern, markWords, MAX_WORDS, searchableInMessages, searchWords, snippet, tsQuery } from '../src/lib/search';

// The ⌘K palette's search: what the database is asked comes only from words, never from operators the user
// typed, and the snippet and highlights follow the same words.

describe('search words', () => {
  it('keeps letters and digits only, lower case, each once', () => {
    expect(searchWords('Deploy  the API! deploy')).toEqual(['deploy', 'the', 'api']);
    expect(searchWords("a & b | !c <-> d:* 'x'")).toEqual(['a', 'b', 'c', 'd', 'x']);
    expect(searchWords('fix bug #42')).toEqual(['fix', 'bug', '42']);
    expect(searchWords('Café über naïve')).toEqual(['café', 'über', 'naïve']);
  });

  it('drops one-letter words unless that is all there is; CJK characters count alone', () => {
    expect(searchWords('a plan b')).toEqual(['plan']);
    expect(searchWords('x')).toEqual(['x']);
    expect(searchWords('東 京')).toEqual(['東', '京']);
  });

  it('caps the words looked for', () => {
    expect(searchWords('one two three four five six seven eight nine ten')).toHaveLength(MAX_WORDS);
    expect(searchWords('   ')).toEqual([]);
  });
});

describe('the database query', () => {
  it('matches every word, and the last one as a prefix only from three characters', () => {
    expect(tsQuery(['quarterly', 'rep'])).toBe('quarterly & rep:*');
    expect(tsQuery(['quarterly', 're'])).toBe('quarterly & re');
    expect(tsQuery(['deplo'])).toBe('deplo:*');
  });

  it('looks in messages only for a word of two characters or more', () => {
    expect(searchableInMessages(['x'])).toBe(false);
    expect(searchableInMessages(['x', 'ok'])).toBe(true);
  });

  it('takes % and _ literally in titles', () => {
    expect(likePattern('50%_off')).toBe('%50\\%\\_off%');
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
  });
});

describe('snippets and highlights', () => {
  const text = 'We looked at several options yesterday. The deployment to staging failed because the database migration timed out after ten minutes, so we rolled back.';

  it('shows the words in context, cut on word boundaries', () => {
    const s = snippet(text, ['deployment'], 20, 40);
    expect(s.startsWith('…')).toBe(true);
    expect(s).toContain('The deployment to staging');
    expect(s.endsWith('…')).toBe(true);
    expect(snippet('short one', ['short'])).toBe('short one');
    expect(snippet('', ['x'])).toBe('');
  });

  it('marks the starts of words only', () => {
    expect(markWords('Redeploy the deploy', ['deploy'])).toEqual([
      { text: 'Redeploy the ', hit: false },
      { text: 'deploy', hit: true },
    ]);
    expect(markWords('Deployment', ['deploy'])).toEqual([
      { text: 'Deploy', hit: true },
      { text: 'ment', hit: false },
    ]);
    expect(markWords('nothing here', [])).toEqual([{ text: 'nothing here', hit: false }]);
  });
});
