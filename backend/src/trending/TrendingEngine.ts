import type { ICountStore } from '../store/CountStore.js';
import type { QueryRecord, Suggestion, TrendingScore } from '../models/index.js';
import { config } from '../config/index.js';

/**
 * Recency-aware ranking ("trending").
 *
 * Two signals per query:
 *   - totalCount  : all-time popularity (historical)
 *   - recentCount : recent activity, kept fresh by EXPONENTIAL DECAY
 *
 * Decay (the key idea): every decay period we multiply recentCount by `decay`
 * (e.g. 0.9) before adding new activity. A one-day spike therefore fades
 * geometrically over subsequent periods (0.9, 0.81, 0.729, …) and stops
 * dominating — directly answering "don't permanently over-rank a short spike".
 * Sustained popularity keeps getting topped up, so it persists.
 *
 * Final ranking blends the two on a common [0,1] scale:
 *   blendedScore = alpha * norm(totalCount) + (1 - alpha) * norm(recentScore)
 *
 *   alpha = 1   -> pure all-time popularity  (the 60% "basic" mode)
 *   alpha = 0.7 -> recency-aware             (the +20% "trending" mode)
 *
 * `score(record)` is exposed so the Trie/cache can rank with the SAME formula,
 * keeping suggestions and trending consistent.
 */
export interface TrendingEngine {
  /** Apply one decay step to every record (called periodically by the worker). */
  decayAll(now: number): void;
  /** Compute the blended ranking score for a record. */
  score(record: QueryRecord): number;
  /** Top-N trending queries with their score breakdown. */
  top(limit: number): TrendingScore[];
  /** Top-N as plain Suggestions (for cache/API symmetry). */
  topSuggestions(limit: number): Suggestion[];
}

export function createTrendingEngine(store: ICountStore): TrendingEngine {
  const { alpha, decay } = config.trending;

  /** Normalize against the current maxima so both signals share a [0,1] scale. */
  function maxima(): { maxCount: number; maxRecent: number } {
    let maxCount = 1;
    let maxRecent = 1;
    for (const r of store.values()) {
      if (r.count > maxCount) maxCount = r.count;
      if (r.recentCount > maxRecent) maxRecent = r.recentCount;
    }
    return { maxCount, maxRecent };
  }

  function blended(r: QueryRecord, maxCount: number, maxRecent: number): number {
    const normTotal = r.count / maxCount;
    const normRecent = r.recentCount / maxRecent;
    return alpha * normTotal + (1 - alpha) * normRecent;
  }

  return {
    decayAll(_now: number): void {
      for (const r of store.values()) {
        r.recentCount *= decay;
        // Drop negligible recency to keep numbers clean (acts as a threshold).
        if (r.recentCount < 1e-3) r.recentCount = 0;
      }
    },

    score(record: QueryRecord): number {
      const { maxCount, maxRecent } = maxima();
      return blended(record, maxCount, maxRecent);
    },

    top(limit: number): TrendingScore[] {
      const { maxCount, maxRecent } = maxima();
      const scored: TrendingScore[] = [];
      for (const r of store.values()) {
        scored.push({
          query: r.query,
          totalCount: r.count,
          recentScore: Number(r.recentCount.toFixed(3)),
          blendedScore: Number(blended(r, maxCount, maxRecent).toFixed(5)),
        });
      }
      // Rank primarily by recent activity for the trending view, tie-break by blend.
      scored.sort((a, b) => b.recentScore - a.recentScore || b.blendedScore - a.blendedScore);
      return scored.slice(0, limit);
    },

    topSuggestions(limit: number): Suggestion[] {
      return this.top(limit).map((t) => ({
        query: t.query,
        count: t.totalCount,
        score: t.blendedScore,
      }));
    },
  };
}
