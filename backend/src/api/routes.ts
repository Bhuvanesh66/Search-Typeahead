import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { metrics } from '../metrics/Metrics.js';
import { config } from '../config/index.js';

/**
 * Register all HTTP routes. Routes stay thin: validate input, delegate to a
 * service, shape the response. Business logic lives in the service/domain layers.
 *
 * Some handlers (search, trending) are provided by later phases via the
 * `extensions` argument so this file does not need to know about the queue or
 * trending engine directly.
 */
export interface RouteExtensions {
  /** POST /search handler — wired in Phase 2.4. */
  onSearch?: (query: string) => Promise<void>;
  /** GET /trending handler — wired in Phase 2.5. */
  getTrending?: (limit: number) => Promise<unknown>;
  /** Worker-side metrics (db_writes etc.) for the /metrics merge — Phase 2.7. */
  getWorkerMetrics?: () => Promise<Record<string, number> | null>;
  /** Current queue depth gauge — Phase 2.7. */
  getQueueDepth?: () => Promise<number>;
}

export function registerRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  ext: RouteExtensions = {},
): void {
  // ── Liveness ──────────────────────────────────────────────────────────────
  app.get('/healthz', async () => ({ status: 'ok', trieSize: ctx.trie.size }));

  // ── GET /suggest?q=&limit= ─────────────────────────────────────────────────
  app.get('/suggest', async (req, reply) => {
    const q = (req.query as Record<string, string>).q;
    const limitRaw = (req.query as Record<string, string>).limit;

    if (q === undefined) {
      return reply.code(400).send({ error: 'missing required query parameter: q' });
    }
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : config.suggest.topK;
    const result = await ctx.suggestService.suggest(q, limit);
    return reply.send(result);
  });

  // ── GET /cache/debug?prefix= ───────────────────────────────────────────────
  app.get('/cache/debug', async (req, reply) => {
    const prefix = (req.query as Record<string, string>).prefix;
    if (prefix === undefined) {
      return reply.code(400).send({ error: 'missing required query parameter: prefix' });
    }
    const result = await ctx.suggestService.debug(prefix);
    return reply.send({
      ...result,
      ringDistribution: ctx.ring.distribution(),
      nodeLiveness: ctx.pool.liveness(),
    });
  });

  // ── POST /search ───────────────────────────────────────────────────────────
  app.post('/search', async (req, reply) => {
    const body = (req.body ?? {}) as { query?: unknown };
    const query = typeof body.query === 'string' ? body.query : '';
    if (!query.trim()) {
      return reply.code(400).send({ error: 'missing or empty field: query' });
    }
    metrics.inc('searches_seen_total');

    // Fire-and-forget the enqueue: the user must NEVER wait on (or fail because
    // of) the counting pipeline. We do NOT await it — even if the queue Redis is
    // slow or down, the response returns immediately. Enqueue errors are handled
    // inside the producer and counted here via the catch.
    if (ext.onSearch) {
      void ext.onSearch(query).catch(() => metrics.inc('enqueue_errors_total'));
    }
    return reply.send({ message: 'Searched' });
  });

  // ── GET /trending?limit= ───────────────────────────────────────────────────
  app.get('/trending', async (req, reply) => {
    const limitRaw = (req.query as Record<string, string>).limit;
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : config.trending.topN;
    if (!ext.getTrending) {
      return reply.send({ trending: [], note: 'trending engine not enabled' });
    }
    const trending = await ext.getTrending(limit);
    return reply.send({ trending });
  });

  // ── GET /metrics ───────────────────────────────────────────────────────────
  app.get('/metrics', async () => {
    metrics.setGauge('trie_size', ctx.trie.size);
    metrics.setGauge('store_size', ctx.store.size);

    // Merge the worker's write-side counters (it's a separate process) so the
    // single /metrics endpoint can report the true write reduction.
    const worker = ext.getWorkerMetrics ? await ext.getWorkerMetrics() : null;
    const queueDepth = ext.getQueueDepth ? await ext.getQueueDepth() : 0;
    if (worker) for (const [k, v] of Object.entries(worker)) metrics.mergeExternal(k, v);
    metrics.setGauge('queue_depth', queueDepth);

    const snap = metrics.snapshot();
    // Recompute write reduction with the real (worker) db_writes.
    const seen = snap.counters.searches_seen_total ?? 0;
    const dbWrites = worker?.db_writes_total ?? snap.counters.db_writes_total ?? 0;
    snap.derived.writes_avoided_total = Math.max(0, seen - dbWrites);
    snap.derived.write_reduction_factor = dbWrites > 0 ? Number((seen / dbWrites).toFixed(2)) : 0;
    return snap;
  });
}
