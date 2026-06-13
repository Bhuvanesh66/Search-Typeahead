/**
 * Shared domain models used across the system.
 *
 * Keeping these in one place gives every module (Trie, cache, queue, workers,
 * trending, API) a single source of truth for the shapes that flow between them.
 */

/** A single suggestion returned for a prefix. */
export interface Suggestion {
  /** The full query string (normalized). */
  query: string;
  /** All-time popularity count. */
  count: number;
  /** Ranking value used for ordering (== count in basic mode, blended in trending mode). */
  score: number;
}

/** A persisted query-count record (source of truth). */
export interface QueryRecord {
  /** Normalized query string — primary key. */
  query: string;
  /** All-time frequency. */
  count: number;
  /** Exponentially-decayed recent activity. */
  recentCount: number;
  /** Epoch ms of last update (for lazy decay). */
  lastUpdated: number;
}

/** One aggregated entry inside a batch window. */
export interface BatchEntry {
  query: string;
  /** Number of times seen in this window. */
  delta: number;
  firstSeen: number;
  lastSeen: number;
}

/** A trending score breakdown for a query. */
export interface TrendingScore {
  query: string;
  totalCount: number;
  recentScore: number;
  blendedScore: number;
}

/** Where a suggestion response was served from. */
export type SuggestSource = 'cache' | 'trie' | 'empty';

/** Response shape for GET /suggest. */
export interface SuggestResponse {
  prefix: string;
  suggestions: Suggestion[];
  source: SuggestSource;
  node: string;
  latencyMs: number;
}

/** Response shape for GET /cache/debug. */
export interface CacheDebugResponse {
  prefix: string;
  normalizedKey: string;
  owningNode: string;
  virtualNodeHit: string;
  status: 'hit' | 'miss';
  ttlRemainingMs: number | null;
  ringPosition: number;
}
