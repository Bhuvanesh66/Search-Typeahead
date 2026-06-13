/**
 * Query / prefix normalization.
 *
 * The SAME normalization MUST be applied on both the write path (when recording
 * a search and building the Trie) and the read path (when looking up a prefix),
 * otherwise prefix matching silently breaks. This is the single shared function.
 *
 * Rules:
 *   - Unicode-normalize (NFC) so visually identical strings compare equal.
 *   - Lowercase (case-insensitive matching).
 *   - Trim leading/trailing whitespace.
 *   - Collapse runs of internal whitespace to a single space.
 */
export function normalize(input: string): string {
  return input
    .normalize('NFC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Max accepted prefix length on the read path (defensive bound). */
export const MAX_PREFIX_LEN = 100;

/** Max accepted query length on the write path. */
export const MAX_QUERY_LEN = 200;

/** Normalize and bound a prefix for /suggest. */
export function normalizePrefix(input: string): string {
  return normalize(input).slice(0, MAX_PREFIX_LEN);
}

/** Normalize and bound a query for /search. Returns '' if effectively empty. */
export function normalizeQuery(input: string): string {
  return normalize(input).slice(0, MAX_QUERY_LEN);
}
