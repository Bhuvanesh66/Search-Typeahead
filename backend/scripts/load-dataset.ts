/**
 * Standalone dataset loader / validator.
 *
 * Loads a `query,count` CSV into a throwaway Trie + store and reports stats.
 * Useful to verify a dataset before booting the server, or to time the load.
 *
 * Usage:
 *   npm run dataset:load -- --file ../datasets/queries.csv
 */
import { Trie } from '../src/trie/Trie.js';
import { InMemoryCountStore } from '../src/store/CountStore.js';
import { loadDataset } from '../src/store/datasetLoader.js';
import { config } from '../src/config/index.js';

function parseFile(argv: string[]): string {
  const idx = argv.indexOf('--file');
  return idx !== -1 && argv[idx + 1] ? argv[idx + 1]! : config.dataset.path;
}

async function main() {
  const file = parseFile(process.argv.slice(2));
  const trie = new Trie({ topK: config.suggest.topK, maxPrefixDepth: config.suggest.maxPrefixDepth });
  const store = new InMemoryCountStore();

  const start = Date.now();
  const result = await loadDataset(file, store, trie, start);
  const durationMs = Date.now() - start;

  // eslint-disable-next-line no-console
  console.log(
    `Loaded ${result.rows} rows (${result.distinct} distinct) from ${file} in ${durationMs}ms`,
  );

  // Smoke-check a couple of prefixes.
  for (const p of ['i', 'how', 'best']) {
    const s = trie.getSuggestions(p, 5);
    // eslint-disable-next-line no-console
    console.log(`  prefix "${p}": ${s.map((x) => x.query).join(', ') || '(none)'}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
