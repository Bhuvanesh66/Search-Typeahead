/**
 * Centralized, environment-driven configuration.
 *
 * Every tunable in the system is read here exactly once and exported as a typed,
 * immutable object. Modules import `config` instead of touching `process.env`,
 * so behavior is reproducible and easy to reason about in a viva.
 */

/** Read an env var as a string, falling back to a default. */
function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

/** Read an env var as an integer, falling back to a default. */
function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Read an env var as a float, falling back to a default. */
function float(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse "host:port,host:port" into structured nodes. */
function parseNodes(raw: string): Array<{ id: string; host: string; port: number }> {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const [host, portStr] = entry.split(':');
      return {
        id: `cache-node-${i}`,
        host: host ?? 'localhost',
        port: Number.parseInt(portStr ?? '6379', 10),
      };
    });
}

export const config = {
  http: {
    port: int('PORT', 3000),
    host: str('HOST', '0.0.0.0'),
    logLevel: str('LOG_LEVEL', 'info'),
  },

  /** Distributed cache nodes (one Redis per node). */
  cacheNodes: parseNodes(str('REDIS_NODES', 'localhost:6380,localhost:6381,localhost:6382')),

  /** Redis used for the Streams-based batch queue. */
  queueRedis: (() => {
    const [host, port] = str('QUEUE_REDIS', 'localhost:6380').split(':');
    return { host: host ?? 'localhost', port: Number.parseInt(port ?? '6380', 10) };
  })(),

  /** Consistent hashing. */
  ring: {
    virtualNodes: int('VIRTUAL_NODES', 150),
  },

  /** Cache TTLs in milliseconds. */
  cache: {
    ttlSuggestMs: int('CACHE_TTL_SUGGEST_MS', 60_000),
    ttlTrendingMs: int('CACHE_TTL_TRENDING_MS', 30_000),
    ttlQueryMs: int('CACHE_TTL_QUERY_MS', 300_000),
  },

  /** Suggestions. */
  suggest: {
    topK: int('TOP_K', 10),
    /** Precompute top-K only up to this depth; 0 = unlimited. Caps Trie memory. */
    maxPrefixDepth: int('MAX_PREFIX_DEPTH', 0),
  },

  /** Batch-write pipeline. */
  batch: {
    size: int('BATCH_SIZE', 1000),
    flushIntervalMs: int('FLUSH_INTERVAL_MS', 2000),
    streamKey: str('STREAM_KEY', 'search_events'),
    consumerGroup: str('CONSUMER_GROUP', 'batch_workers'),
    consumerName: str('CONSUMER_NAME', 'worker-1'),
    /** 1.0 = process every search; <1 enables sampling (data loss, trends preserved). */
    sampleRate: float('SAMPLE_RATE', 1.0),
  },

  /** Trending / ranking. */
  trending: {
    /** blendedScore = alpha * norm(totalCount) + (1 - alpha) * norm(recentScore). */
    alpha: float('TRENDING_ALPHA', 0.7),
    /** Per-period multiplicative decay of recent activity. */
    decay: float('TRENDING_DECAY', 0.9),
    decayIntervalMs: int('TRENDING_DECAY_INTERVAL_MS', 60_000),
    topN: int('TRENDING_TOP_N', 20),
  },

  dataset: {
    path: str('DATASET_PATH', '../datasets/queries.csv'),
  },
} as const;

export type Config = typeof config;
