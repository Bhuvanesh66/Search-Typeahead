/**
 * Performance harness.
 *
 * Drives the running API with a realistic mix of /suggest reads (the hot path)
 * and /search writes, then prints latency percentiles, cache hit ratio, and the
 * write-reduction achieved by batching. Results feed docs/PERFORMANCE.md.
 *
 * Usage (API + worker must be running):
 *   npm run perf -- --requests 50000 --concurrency 100 --writeRatio 0.1
 */
export {}; // mark as an ES module so script-local names don't collide

interface Args {
  base: string;
  requests: number;
  concurrency: number;
  writeRatio: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { base: 'http://127.0.0.1:3000', requests: 20000, concurrency: 50, writeRatio: 0.1 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    if (argv[i] === '--requests') a.requests = Number.parseInt(v ?? '20000', 10);
    else if (argv[i] === '--concurrency') a.concurrency = Number.parseInt(v ?? '50', 10);
    else if (argv[i] === '--writeRatio') a.writeRatio = Number.parseFloat(v ?? '0.1');
    else if (argv[i] === '--base') a.base = v ?? a.base;
  }
  return a;
}

// A spread of prefixes so we exercise many cache keys (and many ring nodes).
const PREFIXES = [
  'i', 'ip', 'iph', 'iphone', 'sa', 'sam', 'java', 'jav', 'py', 'pyth', 're',
  'rea', 'no', 'nod', 'be', 'bes', 'co', 'cof', 'pi', 'piz', 'te', 'tes', 'bi',
  'bit', 'st', 'sto', 'gy', 'gym', 'yo', 'yog', 'gu', 'gui', 'ca', 'cam', 'mo',
  'mon', 'ke', 'key', 'la', 'lap', 'ho', 'how', 'wh', 'wha', 'whe', 'whz',
];
const SEARCH_QUERIES = [
  'iphone pro', 'java tutorial', 'best coffee', 'how to yoga', 'cheap flight',
  'tesla model', 'bitcoin price', 'python guide', 'react hooks', 'pizza near me',
];

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[idx]!.toFixed(3));
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // eslint-disable-next-line no-console
  console.log(`Perf: ${args.requests} requests, concurrency ${args.concurrency}, writeRatio ${args.writeRatio}`);

  const latencies: number[] = [];
  let writes = 0;
  let done = 0;
  let rngState = 123456;
  const rand = () => {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff;
  };

  async function oneRequest(): Promise<void> {
    if (rand() < args.writeRatio) {
      writes++;
      const q = SEARCH_QUERIES[Math.floor(rand() * SEARCH_QUERIES.length)]!;
      const ms = await timed(() =>
        fetch(`${args.base}/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q }),
        }),
      );
      latencies.push(ms);
    } else {
      const p = PREFIXES[Math.floor(rand() * PREFIXES.length)]!;
      const ms = await timed(() => fetch(`${args.base}/suggest?q=${encodeURIComponent(p)}`));
      latencies.push(ms);
    }
    done++;
  }

  // Run a fixed pool of workers pulling from a shared counter.
  const wallStart = performance.now();
  let issued = 0;
  async function worker(): Promise<void> {
    while (issued < args.requests) {
      issued++;
      await oneRequest();
    }
  }
  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
  const wallMs = performance.now() - wallStart;

  latencies.sort((a, b) => a - b);
  const reads = done - writes;
  const throughput = (done / wallMs) * 1000;

  // Pull server-side metrics for hit ratio + write reduction.
  const metrics = (await (await fetch(`${args.base}/metrics`)).json()) as {
    counters: Record<string, number>;
    derived: Record<string, number>;
  };

  const report = {
    config: args,
    client: {
      totalRequests: done,
      reads,
      writes,
      wallMs: Number(wallMs.toFixed(1)),
      throughputRps: Number(throughput.toFixed(1)),
      latencyMs: {
        p50: pct(latencies, 50),
        p95: pct(latencies, 95),
        p99: pct(latencies, 99),
        max: Number(latencies[latencies.length - 1]?.toFixed(3) ?? 0),
      },
    },
    server: {
      cacheHits: metrics.counters.cache_hits_total ?? 0,
      cacheMisses: metrics.counters.cache_misses_total ?? 0,
      cacheHitRatio: metrics.derived.cache_hit_ratio ?? 0,
      searchesSeen: metrics.counters.searches_seen_total ?? 0,
      dbWrites: metrics.counters.db_writes_total ?? 0,
      writesAvoided: metrics.derived.writes_avoided_total ?? 0,
      writeReductionFactor: metrics.derived.write_reduction_factor ?? 0,
      batchFlushes: metrics.counters.batch_flushes_total ?? 0,
    },
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
