import { describe, it, expect } from 'vitest';
import { Metrics } from '../../src/metrics/Metrics.js';

describe('Metrics', () => {
  it('computes cache hit ratio', () => {
    const m = new Metrics();
    m.inc('cache_hits_total', 90);
    m.inc('cache_misses_total', 10);
    expect(m.snapshot().derived.cache_hit_ratio).toBe(0.9);
  });

  it('computes write reduction from searches vs db writes', () => {
    const m = new Metrics();
    m.inc('searches_seen_total', 1000);
    m.inc('db_writes_total', 10);
    const snap = m.snapshot();
    expect(snap.derived.writes_avoided_total).toBe(990);
    expect(snap.derived.write_reduction_factor).toBe(100);
  });

  it('mergeExternal overwrites rather than adds', () => {
    const m = new Metrics();
    m.inc('db_writes_total', 5);
    m.mergeExternal('db_writes_total', 42);
    expect(m.get('db_writes_total')).toBe(42);
  });

  it('produces latency percentiles', () => {
    const m = new Metrics();
    for (let i = 1; i <= 100; i++) m.observe('lat', i);
    const snap = m.snapshot().latencies.lat!;
    expect(snap.count).toBe(100);
    expect(snap.p50).toBeGreaterThan(40);
    expect(snap.p99).toBeGreaterThan(90);
  });
});
