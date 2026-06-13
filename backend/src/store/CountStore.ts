import type { QueryRecord } from '../models/index.js';

/**
 * Primary query-count store — the SOURCE OF TRUTH for popularity.
 *
 * Design note (viva): the Trie's top-K and the Redis cache are *derived* views
 * that can be rebuilt from this store at any time. The store therefore only needs
 * to do two things well: durably hold `count` / `recentCount` per query, and let
 * us iterate all records to rebuild the Trie on boot.
 *
 * This implementation is an in-memory Map with optional file persistence. That is
 * deliberate and sufficient for the assignment's scale (100k–1M rows fit easily in
 * memory) and keeps the dependency surface tiny — easy to explain and to demo.
 * Swapping in Redis/SQL/Mongo later only means re-implementing this interface.
 */
export interface ICountStore {
  /** Get a record (or undefined). */
  get(query: string): QueryRecord | undefined;
  /** Insert if new, else increment by delta. Returns the updated record. */
  increment(query: string, delta: number, now: number): QueryRecord;
  /** Replace the full record (used by trending decay sweeps). */
  put(record: QueryRecord): void;
  /** Iterate all records (for Trie rebuild / decay). */
  values(): IterableIterator<QueryRecord>;
  /** Number of distinct queries. */
  readonly size: number;
}

export class InMemoryCountStore implements ICountStore {
  private readonly map = new Map<string, QueryRecord>();

  get size(): number {
    return this.map.size;
  }

  get(query: string): QueryRecord | undefined {
    return this.map.get(query);
  }

  increment(query: string, delta: number, now: number): QueryRecord {
    let rec = this.map.get(query);
    if (!rec) {
      rec = { query, count: 0, recentCount: 0, lastUpdated: now };
      this.map.set(query, rec);
    }
    rec.count += delta;
    rec.recentCount += delta;
    rec.lastUpdated = now;
    return rec;
  }

  put(record: QueryRecord): void {
    this.map.set(record.query, record);
  }

  values(): IterableIterator<QueryRecord> {
    return this.map.values();
  }
}
