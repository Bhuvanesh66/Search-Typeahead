import { useEffect, useRef, useState, useCallback } from 'react';
import {
  fetchSuggestions,
  submitSearch,
  fetchTrending,
  type Suggestion,
  type TrendingItem,
} from './api.ts';
import { useDebounce } from './useDebounce.ts';

const DEBOUNCE_MS = 150;
const TRENDING_REFRESH_MS = 5000;

export function App() {
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [meta, setMeta] = useState<{ source: string; node: string; latencyMs: number } | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1); // keyboard highlight
  const [open, setOpen] = useState(false);
  const [trending, setTrending] = useState<TrendingItem[]>([]);
  const [lastSearched, setLastSearched] = useState<string | null>(null);

  const debouncedInput = useDebounce(input, DEBOUNCE_MS);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against out-of-order responses overwriting newer ones.
  const requestSeq = useRef(0);

  // ── Fetch suggestions whenever the debounced input changes ─────────────────
  useEffect(() => {
    const q = debouncedInput.trim();
    if (!q) {
      setSuggestions([]);
      setMeta(null);
      setActiveIndex(-1);
      return;
    }
    const seq = ++requestSeq.current;
    fetchSuggestions(q, 10).then((res) => {
      if (seq !== requestSeq.current) return; // a newer request superseded this one
      setSuggestions(res.suggestions);
      setMeta({ source: res.source, node: res.node, latencyMs: res.latencyMs });
      setActiveIndex(-1);
      setOpen(true);
    });
  }, [debouncedInput]);

  // ── Poll trending periodically so live bursts surface in the UI ────────────
  useEffect(() => {
    let active = true;
    const load = () => fetchTrending(10).then((t) => active && setTrending(t));
    load();
    const id = setInterval(load, TRENDING_REFRESH_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const doSearch = useCallback(
    async (query: string) => {
      const q = query.trim();
      if (!q) return;
      setInput(q);
      setOpen(false);
      setLastSearched(q);
      await submitSearch(q);
      // Refresh trending shortly after so the just-submitted query can appear.
      setTimeout(() => fetchTrending(10).then(setTrending), 1200);
    },
    [],
  );

  // ── Keyboard navigation: ArrowUp/Down to move, Enter to select/submit ──────
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) {
      if (e.key === 'Enter') void doSearch(input);
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % suggestions.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
        break;
      case 'Enter': {
        e.preventDefault();
        const chosen = activeIndex >= 0 ? suggestions[activeIndex]!.query : input;
        void doSearch(chosen);
        break;
      }
      case 'Escape':
        setOpen(false);
        break;
    }
  }

  return (
    <div className="page">
      <header className="header">
        <h1>🔎 Search Typeahead</h1>
        <p className="subtitle">
          Distributed cache · consistent hashing · batched writes · recency-aware trending
        </p>
      </header>

      <div className="search-wrap">
        <div className="search-box">
          <input
            ref={inputRef}
            className="search-input"
            type="text"
            placeholder="Start typing… (e.g. iphone, how to, best)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => suggestions.length && setOpen(true)}
            aria-label="Search"
            autoComplete="off"
          />
          <button className="search-btn" onClick={() => void doSearch(input)}>
            Search
          </button>
        </div>

        {open && suggestions.length > 0 && (
          <ul className="dropdown" role="listbox">
            {suggestions.map((s, i) => (
              <li
                key={s.query}
                role="option"
                aria-selected={i === activeIndex}
                className={`item ${i === activeIndex ? 'active' : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep focus; fire before blur
                  void doSearch(s.query);
                }}
              >
                <span className="item-query">{highlight(s.query, debouncedInput)}</span>
                <span className="item-count">{formatCount(s.count)}</span>
              </li>
            ))}
          </ul>
        )}

        {meta && (
          <div className="meta">
            served from <strong>{meta.source}</strong> · node <strong>{meta.node}</strong> ·{' '}
            {meta.latencyMs.toFixed(2)} ms
          </div>
        )}
        {open && debouncedInput.trim() && suggestions.length === 0 && (
          <div className="meta">no suggestions for “{debouncedInput.trim()}”</div>
        )}
      </div>

      {lastSearched && (
        <div className="searched-banner">
          ✅ Searched: <strong>{lastSearched}</strong>
        </div>
      )}

      <section className="trending">
        <h2>🔥 Trending now</h2>
        {trending.length === 0 ? (
          <p className="muted">No trending data yet — submit a few searches.</p>
        ) : (
          <ol className="trending-list">
            {trending.map((t) => (
              <li key={t.query} onClick={() => void doSearch(t.query)} className="trending-item">
                <span className="trending-query">{t.query}</span>
                <span className="trending-stats">
                  {t.recentScore > 0 && <span className="badge-recent">recent {Math.round(t.recentScore)}</span>}
                  <span className="badge-total">{formatCount(t.totalCount)}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="footer">
        Type to see suggestions · ↑/↓ to navigate · Enter to search · click a trend to search it
      </footer>
    </div>
  );
}

/** Bold the matched prefix portion of a suggestion. */
function highlight(query: string, prefix: string) {
  const p = prefix.trim().toLowerCase();
  if (p && query.toLowerCase().startsWith(p)) {
    return (
      <>
        <strong>{query.slice(0, p.length)}</strong>
        {query.slice(p.length)}
      </>
    );
  }
  return query;
}

/** Compact count formatting: 1234567 -> 1.2M. */
function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
