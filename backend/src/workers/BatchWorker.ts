import Redis from 'ioredis';
import type { AppContext } from '../app.js';
import type { TrendingEngine } from '../trending/TrendingEngine.js';
import { BatchAggregator } from './BatchAggregator.js';
import { config } from '../config/index.js';
import { metrics } from '../metrics/Metrics.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('worker');

/**
 * Consumer side of the batch-write pipeline.
 *
 * Loop:
 *   1. XREADGROUP a block of events from the Redis Stream (consumer group).
 *   2. Feed each event into the in-memory aggregator (collapses duplicates).
 *   3. When shouldFlush() (size OR time), flush:
 *        a. write aggregated deltas to the count store (the durable source of truth)
 *        b. update the Trie's counts + top-K for affected queries
 *        c. invalidate the cache for every prefix whose top-K changed
 *        d. XACK the processed stream ids (so they aren't redelivered)
 *   4. Periodically run a decay step so trending recency fades over time.
 *
 * Reliability: we XACK only AFTER the durable write + invalidation. If the worker
 * crashes mid-flush, the un-acked entries remain in the stream's pending list and
 * are re-read on restart (at-least-once). A rare double-count is acceptable per
 * the eventual-consistency NFR.
 */
export class BatchWorker {
  private readonly client: Redis;
  private readonly aggregator: BatchAggregator;
  /** Stream ids buffered alongside the aggregator, acked together on flush. */
  private pendingIds: string[] = [];
  private running = false;
  private lastDecay: number;

  constructor(
    private readonly ctx: AppContext,
    private readonly trending: TrendingEngine,
    now: number,
  ) {
    this.client = new Redis({
      host: config.queueRedis.host,
      port: config.queueRedis.port,
      maxRetriesPerRequest: null, // block reads need this disabled
    });
    this.aggregator = new BatchAggregator(config.batch.size, config.batch.flushIntervalMs, now);
    this.lastDecay = now;
  }

  /** Create the consumer group if it doesn't exist (idempotent). */
  private async ensureGroup(): Promise<void> {
    try {
      await this.client.xgroup(
        'CREATE',
        config.batch.streamKey,
        config.batch.consumerGroup,
        '0',
        'MKSTREAM',
      );
      log.info({ group: config.batch.consumerGroup }, 'consumer group created');
    } catch (err) {
      // BUSYGROUP = already exists; any other error is real.
      if (!(err as Error).message.includes('BUSYGROUP')) throw err;
    }
  }

  async start(): Promise<void> {
    await this.ensureGroup();
    this.running = true;
    log.info(
      { stream: config.batch.streamKey, batchSize: config.batch.size, flushMs: config.batch.flushIntervalMs },
      'batch worker started',
    );

    // The loop must SURVIVE transient errors. A single bad tick (Redis blip, a
    // deleted stream/group, a parse error) must never kill the consumer — that
    // would silently stop all count updates. We catch per-tick, self-heal known
    // recoverable conditions (NOGROUP), and back off briefly on anything else.
    while (this.running) {
      try {
        await this.tick(Date.now());
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('NOGROUP')) {
          // The stream or consumer group vanished (eviction, FLUSH, fresh Redis).
          // Recreate it and continue — no data the user cares about is lost
          // because counts are derived and the user already got "Searched".
          metrics.inc('worker_group_recreated_total');
          log.warn('consumer group missing (NOGROUP) — recreating and continuing');
          this.pendingIds = []; // those ids no longer exist
          await this.ensureGroup().catch(() => undefined);
        } else {
          metrics.inc('worker_tick_errors_total');
          log.error({ err: msg }, 'batch worker tick failed — backing off');
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
  }

  /** One iteration: read some events, aggregate, maybe flush, maybe decay. */
  private async tick(now: number): Promise<void> {
    // Block up to flushIntervalMs waiting for new events, reading up to batchSize.
    const res = (await this.client.xreadgroup(
      'GROUP',
      config.batch.consumerGroup,
      config.batch.consumerName,
      'COUNT',
      config.batch.size,
      'BLOCK',
      config.batch.flushIntervalMs,
      'STREAMS',
      config.batch.streamKey,
      '>',
    )) as Array<[string, Array<[string, string[]]>]> | null;

    if (res) {
      for (const [, entries] of res) {
        for (const [id, fields] of entries) {
          const query = fieldValue(fields, 'q');
          if (query) this.aggregator.add(query, now);
          this.pendingIds.push(id);
        }
      }
    }

    if (this.aggregator.shouldFlush(now)) {
      await this.flush(now);
    }

    // Periodic recency decay so spikes fade, then republish the trending list.
    if (now - this.lastDecay >= config.trending.decayIntervalMs) {
      this.trending.decayAll(now);
      this.lastDecay = now;
      metrics.inc('trending_decays_total');
      await this.publishTrending();
    }
  }

  /**
   * Publish the worker's freshly-computed trending list into the shared cache.
   * The API's GET /trending reads this key, so trending is correct across
   * processes (the same write-through idea used for suggestions).
   */
  private async publishTrending(): Promise<void> {
    const startNs = process.hrtime.bigint();
    const list = this.trending.top(config.trending.topN);
    await this.ctx.cache.setTrending(list, config.cache.ttlTrendingMs);
    metrics.observe('trending_update_latency_ms', Number(process.hrtime.bigint() - startNs) / 1e6);
    await this.publishMetrics();
  }

  /**
   * Publish the worker's write-side counters to a shared Redis key so the API's
   * single /metrics endpoint can report db_writes / write-reduction even though
   * the writes happen in this separate process.
   */
  private async publishMetrics(): Promise<void> {
    const snap = {
      db_writes_total: metrics.get('db_writes_total'),
      batch_flushes_total: metrics.get('batch_flushes_total'),
      events_processed_total: metrics.get('events_processed_total'),
      trending_decays_total: metrics.get('trending_decays_total'),
    };
    await this.client.set('metrics:worker', JSON.stringify(snap)).catch(() => undefined);
  }

  /** Persist aggregated counts, update Trie + cache, then ack. */
  private async flush(now: number): Promise<void> {
    const startNs = process.hrtime.bigint();
    const entries = this.aggregator.drain(now);
    const idsToAck = this.pendingIds;
    this.pendingIds = [];
    if (entries.length === 0) return;

    const changedPrefixes = new Set<string>();

    for (const entry of entries) {
      // a) Durable write: increment the source of truth.
      const rec = this.ctx.store.increment(entry.query, entry.delta, now);
      metrics.inc('db_writes_total'); // ONE write per distinct query, not per event
      metrics.inc('events_processed_total', entry.delta); // events collapsed into it

      // b) Update the Trie's count + top-K; collect prefixes whose top-K changed.
      const changed = this.ctx.trie.insert(entry.query, rec.count);
      for (const p of changed) changedPrefixes.add(p);
    }

    // c) Refresh the cache for every prefix whose ranking changed.
    //
    //    We WRITE THROUGH (recompute + SET) rather than merely invalidating.
    //    Why: the API server and this worker are separate processes with their
    //    own in-memory Tries. The worker's Trie holds the new counts, so it is
    //    the authority for the fresh top-K. Pushing that top-K into the shared
    //    distributed cache makes the cache the single cross-process serving
    //    surface — the API then serves fresh suggestions on its next cache hit,
    //    even though its own Trie never saw the live search. A bare invalidation
    //    would only delete the key, and the API's stale Trie would refill it.
    await Promise.all(
      [...changedPrefixes].map((p) => {
        const fresh = this.ctx.trie.getSuggestions(p, config.suggest.topK);
        return this.ctx.cache.setSuggestions(p, fresh, config.cache.ttlSuggestMs);
      }),
    );

    // d) Refresh the shared trending list so live searches surface promptly.
    await this.publishTrending();

    // e) Ack the processed stream ids — only now that the write is durable.
    //    Then XDEL them so the stream doesn't grow unbounded (we keep no replay
    //    history beyond the consumer-group pending list, which is enough for
    //    crash recovery). queue_depth (XLEN) then reflects only un-processed work.
    if (idsToAck.length > 0) {
      await this.client.xack(config.batch.streamKey, config.batch.consumerGroup, ...idsToAck);
      await this.client.xdel(config.batch.streamKey, ...idsToAck).catch(() => undefined);
    }

    const flushMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    metrics.inc('batch_flushes_total');
    metrics.observe('batch_size', entries.length);
    metrics.observe('batch_flush_ms', flushMs);
    metrics.setGauge('last_batch_distinct', entries.length);
    metrics.setGauge('last_batch_invalidations', changedPrefixes.size);

    log.info(
      { distinct: entries.length, invalidatedPrefixes: changedPrefixes.size, flushMs: Number(flushMs.toFixed(2)) },
      'batch flushed',
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.flush(Date.now()).catch(() => undefined);
    await this.client.quit().catch(() => undefined);
  }
}

/** Extract a field value from a Redis Stream entry's flat [k, v, k, v] array. */
function fieldValue(fields: string[], key: string): string | undefined {
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i] === key) return fields[i + 1];
  }
  return undefined;
}
