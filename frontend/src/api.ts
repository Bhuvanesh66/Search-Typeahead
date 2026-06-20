/**
 * Thin typed client for the backend API.
 *
 * All calls go through the Vite dev proxy at `/api/*` (see vite.config.ts), so
 * there is no CORS/host coupling in the frontend code.
 */

export interface Suggestion {
  query: string;
  count: number;
  score: number;
}

export interface SuggestResponse {
  prefix: string;
  suggestions: Suggestion[];
  source: 'cache' | 'trie' | 'empty';
  node: string;
  latencyMs: number;
}

export interface TrendingItem {
  query: string;
  totalCount: number;
  recentScore: number;
  blendedScore: number;
}

const BASE = '/api';

/** Fetch suggestions for a prefix. Returns an empty result on error. */
export async function fetchSuggestions(q: string, limit = 10): Promise<SuggestResponse> {
  const res = await fetch(`${BASE}/suggest?q=${encodeURIComponent(q)}&limit=${limit}`);
  if (!res.ok) {
    return { prefix: q, suggestions: [], source: 'empty', node: 'none', latencyMs: 0 };
  }
  return (await res.json()) as SuggestResponse;
}

/** Submit a search (records the query for counting). */
export async function submitSearch(query: string): Promise<void> {
  await fetch(`${BASE}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
}

/** Fetch the trending list. */
export async function fetchTrending(limit = 10): Promise<TrendingItem[]> {
  const res = await fetch(`${BASE}/trending?limit=${limit}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { trending: TrendingItem[] };
  return data.trending ?? [];
}
