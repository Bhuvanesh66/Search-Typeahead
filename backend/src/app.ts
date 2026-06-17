/**
 * Application composition root.
 *
 * Builds every long-lived singleton once and wires them together, so the server
 * and the worker can share the exact same construction logic. Keeping wiring in
 * one place (instead of scattered module-level singletons) makes the dependency
 * graph explicit and testable.
 */
import { config } from './config/index.js';
import { Trie } from './trie/Trie.js';
import { InMemoryCountStore } from './store/CountStore.js';
import { loadDataset } from './store/datasetLoader.js';
import { ConsistentHashRing } from './hashing/ConsistentHashRing.js';
import { RedisPool } from './cache/RedisPool.js';
import { DistributedCache } from './cache/DistributedCache.js';
import { SuggestService } from './api/SuggestService.js';
import { childLogger } from './utils/logger.js';

const log = childLogger('app');

export interface AppContext {
  trie: Trie;
  store: InMemoryCountStore;
  ring: ConsistentHashRing;
  pool: RedisPool;
  cache: DistributedCache;
  suggestService: SuggestService;
}

/** Build the consistent-hash ring from the configured cache nodes. */
function buildRing(): ConsistentHashRing {
  const ring = new ConsistentHashRing(config.ring.virtualNodes);
  for (const node of config.cacheNodes) ring.addNode(node.id);
  log.info(
    { nodes: ring.nodeIds, virtualNodes: config.ring.virtualNodes, distribution: ring.distribution() },
    'hash ring built',
  );
  return ring;
}

/**
 * Construct the full application context.
 *
 * @param opts.loadData  whether to load the dataset into the Trie/store on boot
 *                       (the API does; a lightweight tool might not).
 */
export async function buildApp(opts: { loadData: boolean } = { loadData: true }): Promise<AppContext> {
  const trie = new Trie({ topK: config.suggest.topK, maxPrefixDepth: config.suggest.maxPrefixDepth });
  const store = new InMemoryCountStore();

  const ring = buildRing();
  const pool = new RedisPool(config.cacheNodes);
  const cache = new DistributedCache(pool, ring);
  const suggestService = new SuggestService(trie, cache);

  if (opts.loadData) {
    const start = Date.now();
    const result = await loadDataset(config.dataset.path, store, trie, start);
    log.info(
      { rows: result.rows, distinct: result.distinct, durationMs: Date.now() - start },
      'boot dataset load complete',
    );
  }

  return { trie, store, ring, pool, cache, suggestService };
}
