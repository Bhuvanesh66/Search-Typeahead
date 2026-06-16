import type { RedisPool } from './RedisPool.js';
import type { ConsistentHashRing, RingRoute } from '../hashing/ConsistentHashRing.js';
import type { Suggestion, TrendingScore } from '../models/index.js';
import { metrics } from '../metrics/Metrics.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('cache');

/** Cache key builders — one place so keys are consistent everywhere. */
export const cacheKeys = {
  suggest: (prefix: string) => `suggest:${prefix}`,
  trending: () => 'trending',
  query: (query: string) => `query:${query}`,
};

export interface CacheGetResult<T> {
  value: T | null;
  route: RingRoute;
  status: 'hit' | 'miss';
  ttlRemainingMs: number | null;
}

/**
 * Distributed cache facade.
 *
 * Responsibilities:
 *   - Route a key to its owning Redis node via the consistent-hash ring.
 *   - get / set / del with TTL, JSON (de)serialization, and metrics.
 *   - Degrade gracefully: a dead node or Redis error is treated as a cache MISS
 *     (the caller then rebuilds from the Trie), never a request failure.
 *
 * The cache stores *derived* data (precomputed top-K). Losing it is always safe.
 */
export class DistributedCache {
  constructor(
    private readonly pool: RedisPool,
    private readonly ring: ConsistentHashRing,
  ) {}

  /** Compute routing for a key without touching Redis (used by /cache/debug). */
  routeKey(key: string): RingRoute {
    return this.ring.route(key);
  }

  /** Get and JSON-parse a value, recording hit/miss + routing. */
  async get<T>(key: string): Promise<CacheGetResult<T>> {
    const route = this.ring.route(key);
    const client = this.pool.get(route.nodeId);

    if (!client || !this.pool.isLive(route.nodeId)) {
      metrics.inc('cache_misses_total');
      return { value: null, route, status: 'miss', ttlRemainingMs: null };
    }

    try {
      // Pipeline GET + PTTL so debug can report remaining TTL in one round trip.
      const [raw, pttl] = (await client
        .multi()
        .get(key)
        .pttl(key)
        .exec()) as [[Error | null, string | null], [Error | null, number]];

      const value = raw[1];
      if (value === null) {
        metrics.inc('cache_misses_total');
        return { value: null, route, status: 'miss', ttlRemainingMs: null };
      }
      metrics.inc('cache_hits_total');
      const ttl = pttl[1];
      return {
        value: JSON.parse(value) as T,
        route,
        status: 'hit',
        ttlRemainingMs: ttl >= 0 ? ttl : null,
      };
    } catch (err) {
      // Treat any cache error as a miss — never fail the read path.
      metrics.inc('cache_misses_total');
      metrics.inc('cache_errors_total');
      log.warn({ key, node: route.nodeId, err: (err as Error).message }, 'cache get failed');
      return { value: null, route, status: 'miss', ttlRemainingMs: null };
    }
  }

  /** Set a JSON value with TTL (ms). Best-effort: errors are swallowed. */
  async set<T>(key: string, value: T, ttlMs: number): Promise<RingRoute> {
    const route = this.ring.route(key);
    const client = this.pool.get(route.nodeId);
    if (!client || !this.pool.isLive(route.nodeId)) return route;
    try {
      await client.set(key, JSON.stringify(value), 'PX', ttlMs);
    } catch (err) {
      metrics.inc('cache_errors_total');
      log.warn({ key, node: route.nodeId, err: (err as Error).message }, 'cache set failed');
    }
    return route;
  }

  /** Delete a key (cache invalidation). Best-effort. */
  async del(key: string): Promise<void> {
    const route = this.ring.route(key);
    const client = this.pool.get(route.nodeId);
    if (!client || !this.pool.isLive(route.nodeId)) return;
    try {
      await client.del(key);
      metrics.inc('cache_invalidations_total');
    } catch (err) {
      metrics.inc('cache_errors_total');
    }
  }

  /** Convenience typed helpers for suggestion lists. */
  getSuggestions(prefix: string) {
    return this.get<Suggestion[]>(cacheKeys.suggest(prefix));
  }

  setSuggestions(prefix: string, suggestions: Suggestion[], ttlMs: number) {
    return this.set(cacheKeys.suggest(prefix), suggestions, ttlMs);
  }

  invalidateSuggest(prefix: string) {
    return this.del(cacheKeys.suggest(prefix));
  }

  /** Trending list helpers — the worker publishes; the API reads. */
  getTrending() {
    return this.get<TrendingScore[]>(cacheKeys.trending());
  }

  setTrending(list: TrendingScore[], ttlMs: number) {
    return this.set(cacheKeys.trending(), list, ttlMs);
  }
}
