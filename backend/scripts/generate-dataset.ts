/**
 * Dataset generator.
 *
 * Produces a CSV of `query,count` with a realistic, heavy-tailed (Zipf-like)
 * popularity distribution, so the typeahead demo has a sensible ranking signal.
 *
 * The vocabulary is combined across three segments (head + modifier + tail) with
 * an optional numeric salt, giving millions of unique multi-word queries — more
 * than enough to comfortably exceed the 100k minimum without ever stalling on
 * duplicate collisions.
 *
 * Usage:
 *   npm run dataset:generate -- --rows 150000 --out ../datasets/queries.csv
 *
 * Real datasets (AOL logs, Kaggle queries, Wikipedia titles+pageviews) can be
 * used instead — just format them as `query,count` and load with load-dataset.
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

interface Args {
  rows: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { rows: 150_000, out: '../datasets/queries.csv' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rows') args.rows = Number.parseInt(argv[++i] ?? '150000', 10);
    else if (argv[i] === '--out') args.out = argv[++i] ?? args.out;
  }
  return args;
}

// Vocabulary segments used to synthesize plausible multi-word queries.
const HEADS = [
  'iphone', 'samsung', 'java', 'python', 'react', 'node', 'best', 'how to',
  'cheap', 'buy', 'top', 'learn', 'what is', 'why is', 'where to', 'when does',
  'macbook', 'airpods', 'pizza', 'coffee', 'shoes', 'laptop', 'headphones',
  'flight', 'hotel', 'recipe', 'movie', 'song', 'news', 'weather', 'tesla',
  'bitcoin', 'stock', 'gym', 'yoga', 'guitar', 'camera', 'monitor', 'keyboard',
];

const MODIFIERS = [
  '', 'pro', 'max', 'mini', 'ultra', 'plus', 'lite', 'air', 'classic', 'premium',
  'wireless', 'smart', 'portable', 'budget', 'gaming', 'vintage', 'modern',
];

const TAILS = [
  '', '15', '16', 'charger', 'case', 'tutorial', 'near me', 'online', 'review',
  'price', 'deals', '2026', 'for beginners', 'cheap', 'usa', 'india', 'free',
  'download', 'guide', 'comparison', 'vs', 'specs', 'battery life', 'discount',
  'shop', 'store', 'best buy', 'amazon', 'reddit',
];

/**
 * Deterministic pseudo-random generator (mulberry32) so dataset generation is
 * reproducible — important for repeatable demos and tests.
 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

async function main() {
  const { rows, out } = parseArgs(process.argv.slice(2));
  const outPath = resolve(process.cwd(), out);
  await mkdir(dirname(outPath), { recursive: true });

  const rng = makeRng(42);
  const stream = createWriteStream(outPath, { encoding: 'utf8' });
  stream.write('query,count\n');

  const seen = new Set<string>();
  let written = 0;
  let rank = 1;
  let guard = 0;
  const maxGuard = rows * 50; // safety bound against pathological loops

  while (written < rows && guard < maxGuard) {
    guard++;
    const head = pick(rng, HEADS);
    const modifier = pick(rng, MODIFIERS);
    const tail = pick(rng, TAILS);
    // A small numeric salt on ~25% of rows expands the unique space enormously.
    const salt = rng() < 0.25 ? ` ${Math.floor(rng() * 200)}` : '';

    const query = [head, modifier, tail]
      .filter(Boolean)
      .join(' ')
      .concat(salt)
      .replace(/\s+/g, ' ')
      .trim();

    if (seen.has(query)) continue;
    seen.add(query);

    // Zipf-like count: popularity ~ 1/rank, scaled, with a little noise.
    const base = Math.floor(1_000_000 / rank);
    const noise = Math.floor(rng() * Math.max(1, base * 0.1));
    const count = Math.max(1, base + noise);

    stream.write(`${csvEscape(query)},${count}\n`);
    written++;
    rank++;
  }

  await new Promise<void>((res) => stream.end(res));
  // eslint-disable-next-line no-console
  console.log(`Generated ${written} rows -> ${outPath}`);
  if (written < rows) {
    // eslint-disable-next-line no-console
    console.warn(`Warning: vocabulary exhausted at ${written} unique rows.`);
  }
}

/** Escape a CSV field if it contains a comma or quote. */
function csvEscape(field: string): string {
  if (field.includes(',') || field.includes('"')) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
