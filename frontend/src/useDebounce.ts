import { useEffect, useState } from 'react';

/**
 * Debounce a rapidly-changing value.
 *
 * Why (and how it maps to the backend): typeahead fires on every keystroke. Without
 * debouncing, typing "iphone" would issue 6 requests in ~300ms. Debouncing waits
 * until the user pauses (e.g. 150ms) before emitting the latest value, so we make
 * ONE request instead of six — directly satisfying the "avoid unnecessary backend
 * calls" requirement and protecting the cache/Trie from keystroke-rate load.
 */
export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id); // cancel if value changes before the delay elapses
  }, [value, delayMs]);

  return debounced;
}
