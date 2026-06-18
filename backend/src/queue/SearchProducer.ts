import Redis from 'ioredis';
import { config } from '../config/index.js';
import { normalizeQuery } from '../utils/normalize.js';
import { metrics } from '../metrics/Metrics.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('producer');

/**
 * Producer side of the batch-write pipeline.
 *
 * On POST /search we do the absolute minimum on the request path: normalize the
 * query and append one entry to a Redis Stream (XADD). The user gets "Searched"
 * back immediately; all the real work (aggregation, DB write, cache invalidation,
 * trending) happens asynchronously in the worker.
 *
 * Why Redis Streams: it is a durable, append-only log with consumer groups, so a
 * crashed worker can resume from un-acked entries. And it needs no new infra — we
 * already run Redis for the cache.
 *
 * Sampling lever: when SAMPLE_RATE < 1, we probabilistically drop searches before
 * enqueueing. This trades exact counts for a massive write reduction while
 * preserving aggregate trends (uniform random sampling is unbiased).
 */
export interface SearchProducer {
  enqueue(rawQuery: string): Promise<void>;
  /** Read the worker's published metrics (db_writes etc.) for the /metrics merge. */
  readWorkerMetrics(): Promise<Record<string, number> | null>;
  /** Current length of the pending stream (queue depth gauge). */
  queueDepth(): Promise<number>;
  close(): Promise<void>;
}

export function createSearchProducer(): SearchProducer {
  const client = new Redis({
    host: config.queueRedis.host,
    port: config.queueRedis.port,
    maxRetriesPerRequest: 2,
  });

  client.on('error', (err) => log.warn({ err: err.message }, 'queue redis error'));

  return {
    async enqueue(rawQuery: string): Promise<void> {
      const query = normalizeQuery(rawQuery);
      if (!query) return;

      // Sampling: drop (1 - sampleRate) of events. Uses a cheap PRNG; bias-free.
      if (config.batch.sampleRate < 1 && Math.random() > config.batch.sampleRate) {
        metrics.inc('searches_sampled_out_total');
        return;
      }

      await client.xadd(config.batch.streamKey, '*', 'q', query);
      metrics.inc('searches_enqueued_total');
    },

    async readWorkerMetrics(): Promise<Record<string, number> | null> {
      try {
        const raw = await client.get('metrics:worker');
        return raw ? (JSON.parse(raw) as Record<string, number>) : null;
      } catch {
        return null;
      }
    },

    async queueDepth(): Promise<number> {
      try {
        return await client.xlen(config.batch.streamKey);
      } catch {
        return 0;
      }
    },

    async close(): Promise<void> {
      await client.quit().catch(() => undefined);
    },
  };
}
