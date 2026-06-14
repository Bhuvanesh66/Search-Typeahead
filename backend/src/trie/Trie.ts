import { TrieNode } from './TrieNode.js';
import type { Suggestion } from '../models/index.js';
import { normalizePrefix } from '../utils/normalize.js';

export interface TrieOptions {
  /** Max suggestions kept per node. */
  topK: number;
  /**
   * Only maintain `topSuggestions` for nodes up to this prefix depth.
   * 0 = unlimited. Capping depth bounds memory: users rarely type very long
   * prefixes before selecting a suggestion, so deep precompute is wasted.
   */
  maxPrefixDepth: number;
}

/**
 * Augmented prefix tree (Trie) for typeahead suggestions.
 *
 * Design:
 *   - insert(query, count) walks L nodes (L = query length) and, on the way,
 *     keeps each ancestor's `topSuggestions` up to date. So the answer for any
 *     prefix is precomputed.
 *   - getSuggestions(prefix) navigates to the prefix node in O(L) and returns
 *     its precomputed array in O(K) — no subtree DFS.
 *
 * This is the in-memory "compute" layer behind the distributed cache. On a cache
 * miss the API asks the Trie; the Trie's answer then repopulates the cache.
 */
export class Trie {
  private readonly root = new TrieNode();
  private readonly opts: TrieOptions;

  /** Number of distinct queries stored. */
  private wordCount = 0;

  constructor(opts: TrieOptions) {
    this.opts = opts;
  }

  get size(): number {
    return this.wordCount;
  }

  /**
   * Insert a query, or set its count if it already exists.
   *
   * @param rawQuery  query text (will be normalized)
   * @param count     absolute count to set for this query
   * @returns the list of prefixes whose top-K may have changed (for cache invalidation)
   */
  insert(rawQuery: string, count: number): string[] {
    const query = normalizePrefix(rawQuery); // normalize == lowercased/trimmed key
    if (query.length === 0) return [];

    // Walk down, creating nodes as needed, collecting the node path.
    const path: TrieNode[] = [this.root];
    let node = this.root;
    for (const ch of query) {
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
      path.push(node);
    }

    const isNew = !node.isWord;
    node.isWord = true;
    node.count = count;
    if (isNew) this.wordCount++;

    const suggestion: Suggestion = { query, count, score: count };

    // Update top-K along every ancestor prefix (including the word node itself).
    // path[0] is the root (empty prefix); path[d] is the prefix of length d.
    const changedPrefixes: string[] = [];
    const maxDepth = this.opts.maxPrefixDepth;
    for (let depth = 1; depth < path.length; depth++) {
      if (maxDepth > 0 && depth > maxDepth) break;
      const ancestor = path[depth]!;
      if (this.upsertTopK(ancestor.topSuggestions, suggestion)) {
        changedPrefixes.push(query.slice(0, depth));
      }
    }
    return changedPrefixes;
  }

  /**
   * Insert/replace a suggestion in a node's top-K list, keeping it sorted desc
   * and bounded to K. Returns true if the visible top-K changed.
   */
  private upsertTopK(list: Suggestion[], s: Suggestion): boolean {
    const k = this.opts.topK;

    // Remove any existing entry for this query (count may have changed).
    const existingIdx = list.findIndex((e) => e.query === s.query);
    if (existingIdx !== -1) {
      // If the score is unchanged, nothing visible changes.
      if (list[existingIdx]!.score === s.score) return false;
      list.splice(existingIdx, 1);
    }

    // If list is full and this score can't crack the top-K, skip.
    if (existingIdx === -1 && list.length >= k && s.score <= list[list.length - 1]!.score) {
      return false;
    }

    // Insert in sorted position (list is small — K is ~10 — so linear is fine).
    let i = 0;
    while (i < list.length && list[i]!.score >= s.score) i++;
    list.splice(i, 0, { ...s });

    // Trim to K.
    if (list.length > k) list.length = k;
    return true;
  }

  /**
   * Return up to `limit` suggestions for a prefix, sorted by score descending.
   * O(L + K). Returns [] for empty prefix or no matches.
   */
  getSuggestions(rawPrefix: string, limit: number): Suggestion[] {
    const prefix = normalizePrefix(rawPrefix);
    if (prefix.length === 0) return [];

    let node = this.root;
    for (const ch of prefix) {
      const next = node.children.get(ch);
      if (!next) return []; // no query starts with this prefix
      node = next;
    }

    // If we precomputed top-K for this depth, return it directly.
    if (node.topSuggestions.length > 0 || this.opts.maxPrefixDepth === 0) {
      return node.topSuggestions.slice(0, limit);
    }

    // Beyond maxPrefixDepth: fall back to a bounded subtree scan.
    return this.collectTopK(node, prefix, limit);
  }

  /**
   * Bounded subtree DFS used only for prefixes deeper than maxPrefixDepth.
   * Collects all words under `node` and returns the top `limit` by count.
   */
  private collectTopK(node: TrieNode, prefix: string, limit: number): Suggestion[] {
    const found: Suggestion[] = [];
    const stack: Array<{ n: TrieNode; s: string }> = [{ n: node, s: prefix }];
    while (stack.length) {
      const { n, s } = stack.pop()!;
      if (n.isWord) found.push({ query: s, count: n.count, score: n.count });
      for (const [ch, child] of n.children) stack.push({ n: child, s: s + ch });
    }
    found.sort((a, b) => b.score - a.score);
    return found.slice(0, limit);
  }
}
