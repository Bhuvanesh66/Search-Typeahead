import type { Trie } from '../trie/Trie.js';
import type { DistributedCache } from '../cache/DistributedCache.js';
import { cacheKeys } from '../cache/DistributedCache.js';
import type { SuggestResponse, CacheDebugResponse } from '../models/index.js';
import { normalizePrefix } from '../utils/normalize.js';
import { metrics } from '../metrics/Metrics.js';
import { config } from '../config/index.js';

/**
 * Orchestrates the read path using the cache-aside pattern:
 *
 *   1. normalize the prefix
 *   2. cache GET (routed by the consistent-hash ring)
 *        - HIT  -> return immediately (the O(1) hot path)
 *        - MISS -> ask the Trie for precomputed top-K, populate the cache, return
 *
 * The Trie is the rebuildable fallback; the cache is the fast distributed front.
 */
export class SuggestService {
  constructor(
    private readonly trie: Trie,
    private readonly cache: DistributedCache,
  ) {}

  async suggest(rawPrefix: string, rawLimit: number): Promise<SuggestResponse> {
    const startNs = process.hrtime.bigint();
    const prefix = normalizePrefix(rawPrefix);
    const limit = clampLimit(rawLimit);

    if (prefix.length === 0) {
      return finish(prefix, [], 'empty', 'none', startNs);
    }

    // 1) Try the distributed cache.
    const cached = await this.cache.getSuggestions(prefix);
    if (cached.status === 'hit' && cached.value) {
      return finish(prefix, cached.value.slice(0, limit), 'cache', cached.route.nodeId, startNs);
    }

    // 2) Miss -> compute from the Trie and repopulate the cache.
    metrics.inc('db_reads_total');
    const suggestions = this.trie.getSuggestions(prefix, config.suggest.topK);

    // Populate the cache with the full top-K so future reads of any limit hit.
    //
    // IMPORTANT: do NOT cache an EMPTY result. The API server and the batch
    // worker have separate in-memory Tries; for a query only the worker has seen
    // (a freshly-searched prefix), the API's Trie returns [] while the worker has
    // already written the real top-K via write-through. Caching [] here would
    // CLOBBER that fresh value and the update would never surface. Skipping empty
    // results costs only a cheap repeated Trie lookup until real data exists.
    if (suggestions.length > 0) {
      await this.cache.setSuggestions(prefix, suggestions, config.cache.ttlSuggestMs);
    }

    const node = cached.route.nodeId;
    return finish(prefix, suggestions.slice(0, limit), 'trie', node, startNs);
  }

  /**
   * Debug routing for a prefix: which node owns it, hit/miss, TTL, ring position.
   * Demonstrates consistent hashing live in the viva.
   */
  async debug(rawPrefix: string): Promise<CacheDebugResponse> {
    const prefix = normalizePrefix(rawPrefix);
    const key = cacheKeys.suggest(prefix);
    const result = await this.cache.get(key);
    return {
      prefix,
      normalizedKey: key,
      owningNode: result.route.nodeId,
      virtualNodeHit: result.route.virtualNode,
      status: result.status,
      ttlRemainingMs: result.ttlRemainingMs,
      ringPosition: result.route.ringPosition,
    };
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return config.suggest.topK;
  return Math.min(limit, config.suggest.topK);
}

function finish(
  prefix: string,
  suggestions: SuggestResponse['suggestions'],
  source: SuggestResponse['source'],
  node: string,
  startNs: bigint,
): SuggestResponse {
  const latencyMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  metrics.observe('search_latency_ms', latencyMs);
  return { prefix, suggestions, source, node, latencyMs: Number(latencyMs.toFixed(3)) };
}
