import { describe, it, expect } from 'vitest';
import { BatchAggregator } from '../../src/workers/BatchAggregator.js';

describe('BatchAggregator', () => {
  it('collapses duplicate queries into deltas', () => {
    const agg = new BatchAggregator(1000, 2000, 0);
    agg.add('iphone', 1);
    agg.add('iphone', 2);
    agg.add('java', 3);
    expect(agg.distinctCount).toBe(2);
    expect(agg.eventCount).toBe(3);
    const drained = agg.drain(10);
    const iphone = drained.find((e) => e.query === 'iphone');
    expect(iphone?.delta).toBe(2);
  });

  it('flushes when batch size is reached', () => {
    const agg = new BatchAggregator(3, 100000, 0);
    agg.add('a', 1);
    agg.add('b', 1);
    expect(agg.shouldFlush(1)).toBe(false);
    agg.add('c', 1);
    expect(agg.shouldFlush(2)).toBe(true);
  });

  it('flushes when the time window elapses', () => {
    const agg = new BatchAggregator(1000, 2000, 0);
    agg.add('a', 1);
    expect(agg.shouldFlush(1999)).toBe(false);
    expect(agg.shouldFlush(2000)).toBe(true);
  });

  it('does not flush an empty buffer', () => {
    const agg = new BatchAggregator(10, 1, 0);
    expect(agg.shouldFlush(100000)).toBe(false);
  });

  it('resets the window after draining', () => {
    const agg = new BatchAggregator(1000, 2000, 0);
    agg.add('a', 1);
    agg.drain(5000);
    expect(agg.distinctCount).toBe(0);
    agg.add('b', 5001);
    expect(agg.shouldFlush(5500)).toBe(false); // window restarted at 5000
  });
});
