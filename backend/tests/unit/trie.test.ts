import { describe, it, expect } from 'vitest';
import { Trie } from '../../src/trie/Trie.js';

function makeTrie() {
  const trie = new Trie({ topK: 10, maxPrefixDepth: 0 });
  trie.insert('iphone', 100000);
  trie.insert('iphone 15', 85000);
  trie.insert('iphone charger', 60000);
  trie.insert('java tutorial', 40000);
  trie.insert('javascript', 90000);
  return trie;
}

describe('Trie', () => {
  it('returns prefix matches sorted by count desc', () => {
    const trie = makeTrie();
    const s = trie.getSuggestions('iph', 10);
    expect(s.map((x) => x.query)).toEqual(['iphone', 'iphone 15', 'iphone charger']);
  });

  it('respects the limit', () => {
    const trie = makeTrie();
    expect(trie.getSuggestions('iph', 2)).toHaveLength(2);
  });

  it('is case-insensitive', () => {
    const trie = makeTrie();
    expect(trie.getSuggestions('IPH', 10)[0]?.query).toBe('iphone');
  });

  it('returns [] for empty prefix', () => {
    expect(makeTrie().getSuggestions('', 10)).toEqual([]);
  });

  it('returns [] for no matches', () => {
    expect(makeTrie().getSuggestions('zzz', 10)).toEqual([]);
  });

  it('distinguishes prefixes that share a stem', () => {
    const trie = makeTrie();
    const ja = trie.getSuggestions('java', 10).map((x) => x.query);
    expect(ja).toContain('java tutorial');
    expect(ja).toContain('javascript');
    const jas = trie.getSuggestions('javas', 10).map((x) => x.query);
    expect(jas).toEqual(['javascript']);
  });

  it('updates count and re-ranks when a query is re-inserted higher', () => {
    const trie = makeTrie();
    trie.insert('iphone 15', 200000); // now the most popular
    expect(trie.getSuggestions('iph', 10)[0]?.query).toBe('iphone 15');
  });

  it('reports changed prefixes for cache invalidation', () => {
    const trie = makeTrie();
    const changed = trie.insert('iphone 17 pro max', 999999);
    // Every prefix of the new top query should be flagged.
    expect(changed).toContain('i');
    expect(changed).toContain('iphone');
    expect(changed).toContain('iphone 17 pro max');
  });
});
