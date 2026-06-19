import { describe, it, expect } from 'vitest';
import { InMemoryCountStore } from '../../src/store/CountStore.js';
import { createTrendingEngine } from '../../src/trending/TrendingEngine.js';

describe('TrendingEngine', () => {
  it('ranks a recently-spiking query above a historically-popular one', () => {
    const store = new InMemoryCountStore();
    // Historically huge but no recent activity.
    store.put({ query: 'why is the sky blue', count: 5_000_000, recentCount: 0, lastUpdated: 0 });
    // Smaller all-time count but a big recent spike.
    store.put({ query: 'what happened in nepal', count: 500, recentCount: 0, lastUpdated: 0 });

    const engine = createTrendingEngine(store);
    // Simulate a recent burst on the trending query.
    const rec = store.get('what happened in nepal')!;
    rec.recentCount = 100000;

    const top = engine.top(2);
    expect(top[0]?.query).toBe('what happened in nepal');
  });

  it('decays recent activity so spikes fade over time', () => {
    const store = new InMemoryCountStore();
    store.put({ query: 'spike', count: 100, recentCount: 1000, lastUpdated: 0 });
    const engine = createTrendingEngine(store);

    engine.decayAll(1);
    const after1 = store.get('spike')!.recentCount;
    expect(after1).toBeLessThan(1000);
    expect(after1).toBeCloseTo(900, 0); // decay 0.9

    engine.decayAll(2);
    const after2 = store.get('spike')!.recentCount;
    expect(after2).toBeCloseTo(810, 0);
  });

  it('falls back to popularity ordering when there is no recent activity', () => {
    const store = new InMemoryCountStore();
    store.put({ query: 'big', count: 1000, recentCount: 0, lastUpdated: 0 });
    store.put({ query: 'small', count: 10, recentCount: 0, lastUpdated: 0 });
    const engine = createTrendingEngine(store);
    const top = engine.top(2);
    // With zero recent activity, blendedScore (alpha-weighted total) breaks the tie.
    expect(top[0]?.query).toBe('big');
  });
});
