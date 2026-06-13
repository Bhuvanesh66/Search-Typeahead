import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { Trie } from '../trie/Trie.js';
import type { ICountStore } from './CountStore.js';
import { normalizeQuery } from '../utils/normalize.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger('dataset');

export interface LoadResult {
  rows: number;
  distinct: number;
}

/**
 * Stream a `query,count` CSV into both the count store and the Trie.
 *
 * Streaming (line by line) keeps memory flat even for multi-million-row files —
 * we never hold the whole file in memory. Each row is normalized with the SAME
 * normalizer used on the read path so prefixes match.
 *
 * @param now  injected clock (epoch ms) so loading is deterministic/testable.
 */
export async function loadDataset(
  filePath: string,
  store: ICountStore,
  trie: Trie,
  now: number,
): Promise<LoadResult> {
  const abs = resolve(process.cwd(), filePath);
  let rows = 0;
  let isHeader = true;

  const rl = createInterface({
    input: createReadStream(abs, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (isHeader) {
      isHeader = false;
      // Skip a header row if present (e.g. "query,count").
      if (/^\s*query\s*,\s*count\s*$/i.test(line)) continue;
    }
    const parsed = parseCsvLine(line);
    if (!parsed) continue;

    const query = normalizeQuery(parsed.query);
    if (!query) continue;

    // Seed the store and Trie with the historical count.
    store.put({ query, count: parsed.count, recentCount: 0, lastUpdated: now });
    trie.insert(query, parsed.count);
    rows++;
  }

  const result: LoadResult = { rows, distinct: store.size };
  log.info({ ...result, file: abs }, 'dataset loaded');
  return result;
}

/** Parse one CSV line of `query,count`, tolerating quoted queries. */
function parseCsvLine(line: string): { query: string; count: number } | null {
  if (!line || !line.trim()) return null;

  let query: string;
  let rest: string;

  if (line.startsWith('"')) {
    // Quoted query: find the closing quote (handling "" escapes).
    let i = 1;
    let buf = '';
    while (i < line.length) {
      const ch = line[i]!;
      if (ch === '"') {
        if (line[i + 1] === '"') {
          buf += '"';
          i += 2;
          continue;
        }
        break;
      }
      buf += ch;
      i++;
    }
    query = buf;
    rest = line.slice(i + 1).replace(/^,/, '');
  } else {
    const idx = line.lastIndexOf(',');
    if (idx === -1) return null;
    query = line.slice(0, idx);
    rest = line.slice(idx + 1);
  }

  const count = Number.parseInt(rest.trim(), 10);
  if (!Number.isFinite(count)) return null;
  return { query, count: Math.max(0, count) };
}
