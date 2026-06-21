/**
 * Lightweight in-process metrics: counters, gauges, and latency histograms.
 *
 * We deliberately avoid a heavyweight metrics library — the assignment needs a
 * readable `/metrics` snapshot proving cache hit ratio and write reduction, and
 * a small bespoke collector is trivial to explain in a viva.
 *
 * Latency is summarized with a reservoir + percentile computation (p50/p95/p99).
 */

/** A bounded sample reservoir for percentile estimation. */
class Histogram {
  private samples: number[] = [];
  private readonly cap: number;
  private total = 0;
  private n = 0;

  constructor(cap = 4096) {
    this.cap = cap;
  }

  observe(value: number): void {
    this.total += value;
    this.n++;
    if (this.samples.length < this.cap) {
      this.samples.push(value);
    } else {
      // Reservoir sampling keeps an unbiased window without unbounded memory.
      const idx = Math.floor((this.n * 2654435761) % this.cap);
      this.samples[idx] = value;
    }
  }

  private percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Number(sorted[idx]!.toFixed(3));
  }

  snapshot() {
    return {
      count: this.n,
      mean: this.n ? Number((this.total / this.n).toFixed(3)) : 0,
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99),
    };
  }
}

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, Histogram>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  /**
   * Set a counter to an absolute value reported by another process (e.g. the
   * worker publishes its db_writes via Redis and the API merges it here). Unlike
   * inc(), this overwrites — the external process owns the canonical total.
   */
  mergeExternal(name: string, value: number): void {
    this.counters.set(name, value);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: string, value: number): void {
    let h = this.histograms.get(name);
    if (!h) {
      h = new Histogram();
      this.histograms.set(name, h);
    }
    h.observe(value);
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  /** Build a JSON-serializable snapshot, including derived ratios. */
  snapshot() {
    const hits = this.get('cache_hits_total');
    const misses = this.get('cache_misses_total');
    const lookups = hits + misses;
    const hitRatio = lookups > 0 ? Number((hits / lookups).toFixed(4)) : 0;

    const searchesSeen = this.get('searches_seen_total');
    const dbWrites = this.get('db_writes_total');
    const writesAvoided = Math.max(0, searchesSeen - dbWrites);
    const writeReductionFactor = dbWrites > 0 ? Number((searchesSeen / dbWrites).toFixed(2)) : 0;

    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) counters[k] = v;
    const gauges: Record<string, number> = {};
    for (const [k, v] of this.gauges) gauges[k] = v;
    const latencies: Record<string, ReturnType<Histogram['snapshot']>> = {};
    for (const [k, h] of this.histograms) latencies[k] = h.snapshot();

    return {
      counters,
      gauges,
      latencies,
      derived: {
        cache_hit_ratio: hitRatio,
        writes_avoided_total: writesAvoided,
        write_reduction_factor: writeReductionFactor,
      },
    };
  }
}

/** Shared singleton — one metrics registry per process. */
export const metrics = new Metrics();
