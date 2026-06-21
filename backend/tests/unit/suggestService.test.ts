import { describe, it, expect, vi } from 'vitest';
import { SuggestService } from '../../src/api/SuggestService.js';
import { Trie } from '../../src/trie/Trie.js';

/**
 * Regression tests for SuggestService, focused on the cache-aside contract and
 * the bug QA found: the API must NOT cache an empty result, or it clobbers the
 * worker's write-through for queries only the worker has seen.
 */

function makeTrie() {
  const trie = new Trie({ topK: 10, maxPrefixDepth: 0 });
  trie.insert('iphone', 100);
  return trie;
}

/** Minimal cache stub recording set() calls. */
function makeCacheStub(getResult: { status: 'hit' | 'miss'; value: unknown }) {
  const setCalls: Array<{ prefix: string; value: unknown }> = [];
  const cache = {
    getSuggestions: vi.fn(async () => ({
      status: getResult.status,
      value: getResult.value,
      route: { nodeId: 'cache-node-0', virtualNode: 'cache-node-0#1', ringPosition: 1 },
      ttlRemainingMs: getResult.status === 'hit' ? 1000 : null,
    })),
    setSuggestions: vi.fn(async (prefix: string, value: unknown) => {
      setCalls.push({ prefix, value });
      return { nodeId: 'cache-node-0', virtualNode: 'cache-node-0#1', ringPosition: 1 };
    }),
    // unused by these tests
    get: vi.fn(),
  };
  return { cache, setCalls };
}

describe('SuggestService', () => {
  it('returns cached suggestions on a hit (source=cache)', async () => {
    const trie = makeTrie();
    const { cache } = makeCacheStub({
      status: 'hit',
      value: [{ query: 'iphone', count: 100, score: 100 }],
    });
    const svc = new SuggestService(trie, cache as never);
    const res = await svc.suggest('iph', 10);
    expect(res.source).toBe('cache');
    expect(res.suggestions[0]?.query).toBe('iphone');
  });

  it('falls back to the Trie on a miss and caches the non-empty result', async () => {
    const trie = makeTrie();
    const { cache, setCalls } = makeCacheStub({ status: 'miss', value: null });
    const svc = new SuggestService(trie, cache as never);
    const res = await svc.suggest('iph', 10);
    expect(res.source).toBe('trie');
    expect(res.suggestions[0]?.query).toBe('iphone');
    // It SHOULD cache the non-empty result.
    expect(setCalls).toHaveLength(1);
  });

  it('does NOT cache an empty result on a miss (prevents clobbering write-through)', async () => {
    const trie = makeTrie();
    const { cache, setCalls } = makeCacheStub({ status: 'miss', value: null });
    const svc = new SuggestService(trie, cache as never);
    const res = await svc.suggest('nonexistent', 10);
    expect(res.suggestions).toEqual([]);
    // Crucially: no cache write for an empty result.
    expect(setCalls).toHaveLength(0);
  });

  it('returns [] with source=empty for an empty prefix', async () => {
    const trie = makeTrie();
    const { cache } = makeCacheStub({ status: 'miss', value: null });
    const svc = new SuggestService(trie, cache as never);
    const res = await svc.suggest('', 10);
    expect(res.source).toBe('empty');
    expect(res.suggestions).toEqual([]);
  });
});
