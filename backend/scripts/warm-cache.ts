/**
 * Cache warmer.
 *
 * Pre-populates the distributed cache with suggestions for the most popular
 * prefixes, so the demo starts with a high cache-hit ratio instead of cold.
 *
 * It simply calls /suggest for a spread of short prefixes (1–3 chars), which
 * causes the API to compute top-K from the Trie and store it in the cache. This
 * reuses the exact production read path — no special warming code in the server.
 *
 * Usage (API must be running):
 *   npm run warm
 */
export {}; // mark as an ES module so script-local names don't collide

const BASE = process.env.WARM_BASE ?? 'http://127.0.0.1:3000';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

async function main() {
  const prefixes: string[] = [];
  // All single letters.
  for (const a of ALPHABET) prefixes.push(a);
  // Common two-letter prefixes (cheap and high-coverage).
  for (const a of ALPHABET) for (const b of 'aeiou') prefixes.push(a + b);

  let warmed = 0;
  for (const p of prefixes) {
    const res = await fetch(`${BASE}/suggest?q=${p}`);
    if (res.ok) warmed++;
  }
  // eslint-disable-next-line no-console
  console.log(`Warmed ${warmed}/${prefixes.length} prefixes into the cache.`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
