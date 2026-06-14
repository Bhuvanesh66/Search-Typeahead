import type { Suggestion } from '../models/index.js';

/**
 * A single node in the augmented Trie.
 *
 * The augmentation is `topSuggestions`: the precomputed top-K queries for the
 * prefix that ends at this node. Because this is maintained incrementally on
 * insert, a read does NOT need to traverse the subtree — it returns this array
 * directly. That is what turns the miss path into O(L + K) and the cache hit
 * path (which stores the same array) into O(1).
 */
export class TrieNode {
  /** Sparse children keyed by single character. Map avoids fixed-array waste. */
  readonly children: Map<string, TrieNode> = new Map();

  /** True if a complete query terminates at this node. */
  isWord = false;

  /** Count of the full query terminating here (0 if not a word). */
  count = 0;

  /**
   * Precomputed top-K suggestions for this prefix, sorted by score descending.
   * Length is bounded by the configured K.
   */
  topSuggestions: Suggestion[] = [];
}
