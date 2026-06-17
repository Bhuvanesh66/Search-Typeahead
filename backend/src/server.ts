/**
 * HTTP server entry point.
 *
 * Boots the application context (Trie + dataset + cache ring), wires the write
 * path (queue) and trending engine if available, registers routes, and listens.
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config/index.js';
import { buildApp } from './app.js';
import { registerRoutes, type RouteExtensions } from './api/routes.js';
import { createSearchProducer } from './queue/SearchProducer.js';
import { createTrendingEngine } from './trending/TrendingEngine.js';
import { logger } from './utils/logger.js';

async function main() {
  const ctx = await buildApp({ loadData: true });

  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  // ── Write path (Phase 2.4): enqueue searches to the batch queue ────────────
  const producer = createSearchProducer();

  // ── Trending engine (Phase 2.5): read-only ranking view for /trending ──────
  const trending = createTrendingEngine(ctx.store);

  const ext: RouteExtensions = {
    onSearch: (query) => producer.enqueue(query),
    // Trending is published to the shared cache by the worker (cross-process
    // correct). The API reads that key and only falls back to its own engine
    // (dataset baseline) on a cold cache before the first publish.
    getTrending: async (limit) => {
      const cached = await ctx.cache.getTrending();
      if (cached.status === 'hit' && cached.value) return cached.value.slice(0, limit);
      return trending.top(limit);
    },
    getWorkerMetrics: () => producer.readWorkerMetrics(),
    getQueueDepth: () => producer.queueDepth(),
  };

  registerRoutes(app, ctx, ext);

  await app.listen({ port: config.http.port, host: config.http.host });
  logger.info(
    { port: config.http.port, host: config.http.host, trieSize: ctx.trie.size },
    'API server listening',
  );

  // Graceful shutdown.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await producer.close();
    await ctx.pool.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal: server failed to start');
  process.exit(1);
});
