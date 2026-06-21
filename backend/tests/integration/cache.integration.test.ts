/**
 * Integration test for the distributed cache over the consistent-hash ring,
 * against the real Redis nodes started by docker-compose.
 *
 * Skipped automatically if Redis isn't reachable, so the unit suite stays green
 * in environments without Docker. Run the cache nodes first:
 *   docker compose up -d
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConsistentHashRing } from '../../src/hashing/ConsistentHashRing.js';
import { RedisPool } from '../../src/cache/RedisPool.js';
import { DistributedCache } from '../../src/cache/DistributedCache.js';
import type { Suggestion } from '../../src/models/index.js';

const NODES = [
  { id: 'cache-node-0', host: '127.0.0.1', port: 6380 },
  { id: 'cache-node-1', host: '127.0.0.1', port: 6381 },
  { id: 'cache-node-2', host: '127.0.0.1', port: 6382 },
];

let pool: RedisPool;
let cache: DistributedCache;
let available = false;

beforeAll(async () => {
  pool = new RedisPool(NODES);
  // Poll readiness for up to ~3s so slower CI/Docker starts don't false-skip.
  for (let i = 0; i < 15 && !available; i++) {
    await new Promise((r) => setTimeout(r, 200));
    available = NODES.every((n) => pool.isLive(n.id));
  }
  const ring = new ConsistentHashRing(150);
  for (const n of NODES) ring.addNode(n.id);
  cache = new DistributedCache(pool, ring);
});

afterAll(async () => {
  await pool?.disconnect();
});

describe('DistributedCache (integration)', () => {
  it('routes consistently and round-trips suggestions through Redis', async () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('Redis not reachable — skipping integration test.');
      return;
    }

    const prefix = 'integ-test-prefix';
    const data: Suggestion[] = [
      { query: 'integ-test-prefix one', count: 10, score: 10 },
      { query: 'integ-test-prefix two', count: 5, score: 5 },
    ];

    const route = await cache.setSuggestions(prefix, data, 5000);
    const got = await cache.getSuggestions(prefix);

    expect(got.status).toBe('hit');
    expect(got.value).toEqual(data);
    // The same key must route to the same node on get and set.
    expect(got.route.nodeId).toBe(route.nodeId);
  });

  it('reports a miss after invalidation', async () => {
    if (!available) return;
    const prefix = 'integ-test-invalidate';
    await cache.setSuggestions(prefix, [{ query: 'x', count: 1, score: 1 }], 5000);
    await cache.invalidateSuggest(prefix);
    const got = await cache.getSuggestions(prefix);
    expect(got.status).toBe('miss');
  });
});
