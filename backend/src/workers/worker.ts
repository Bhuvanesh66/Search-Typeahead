/**
 * Batch worker entry point (separate process from the API).
 *
 * Runs the consumer side of the write pipeline: reads search events from the
 * Redis Stream, aggregates them, and periodically flushes durable count updates
 * + Trie/cache updates + recency decay.
 *
 * It builds its own application context (its own Trie + store + cache) so it can
 * keep the Trie's top-K current and invalidate the right cache keys. The count
 * store is the shared source of truth conceptually; in this single-host demo each
 * process holds its own in-memory store, which is fine because the API rebuilds
 * its Trie from the dataset on boot and the cache is the cross-process surface.
 */
import { buildApp } from '../app.js';
import { createTrendingEngine } from '../trending/TrendingEngine.js';
import { BatchWorker } from './BatchWorker.js';
import { logger } from '../utils/logger.js';

async function main() {
  const ctx = await buildApp({ loadData: true });
  const trending = createTrendingEngine(ctx.store);
  const worker = new BatchWorker(ctx, trending, Date.now());

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    await worker.stop();
    await ctx.pool.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await worker.start();
}

main().catch((err) => {
  logger.error({ err }, 'fatal: worker failed');
  process.exit(1);
});
