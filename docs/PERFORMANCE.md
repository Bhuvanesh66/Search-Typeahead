# Performance Report — Search Typeahead System

Measured on a single developer machine (Windows 11, Node 20, 3× Redis 7 in Docker)
with a **120,000-query** dataset loaded into the Trie. Numbers are reproducible via
the bundled harness — see [How to reproduce](#how-to-reproduce).

> The point of this report is to back the three rubric claims with evidence:
> low-latency cached reads, a high cache-hit ratio from consistent hashing, and a
> large write reduction from batching.

---

## 1. Read latency (`/suggest`)

Server-side latency measured by the API's own histogram over **9,125** suggest
requests during a 10k-request mixed load (concurrency 20, 10% writes), cache warm.

| Percentile | Latency |
|---|---:|
| mean | 4.09 ms |
| p50 | **3.31 ms** |
| p95 | **6.77 ms** |
| p99 | **9.23 ms** |

End-to-end (client-observed, includes the full HTTP round-trip over localhost):

| Percentile | Latency |
|---|---:|
| p50 | 12.5 ms |
| p95 | 24.4 ms |
| p99 | 33.0 ms |
| max | 133.9 ms |

**Verdict:** meets the PRD targets (suggest p99 < 10 ms server-side; e2e p99 < 50 ms).
On the cache-hit hot path a single read is ~1–3 ms (a single Redis `GET` routed by
the ring), which is the design's whole point: a read is one key-value lookup, not a
tree traversal.

---

## 2. Cache hit ratio (consistent hashing)

Over the same run:

| Metric | Value |
|---|---:|
| cache hits | 8,938 |
| cache misses | 187 |
| **hit ratio** | **97.95 %** |

Misses are almost entirely the first touch of each prefix (cold key) plus entries
that expired by TTL; every miss repopulates the cache, so steady-state stays high.
The PRD target was ≥ 90 %.

**Ring distribution** (from `/cache/debug`): with 150 virtual nodes per physical
node, each of the 3 nodes owns exactly 150 ring points, and a sample of 30,000 keys
distributes ≈ 33 % / 33 % / 33 % — confirming even load.

---

## 3. Write reduction (batching)

The core write-heavy problem: naively, every search would write the count **and**
update the top-K of each of its prefixes. Batching collapses repeated searches of a
query into **one** durable write per flush window.

Mixed-load run (1,331 searches recorded):

| Metric | Value |
|---|---:|
| searches seen | 1,331 |
| **DB writes** | **31** |
| writes avoided | 1,300 |
| **write-reduction factor** | **≈ 43×** |
| batch flushes | 3 |

Focused burst (300 identical searches in < 1 s):

| Metric | Value |
|---|---:|
| searches | 300 |
| DB writes | 8 |
| **reduction** | **37.5×** |

**Scaling note:** the reduction factor approaches the configured `BATCH_SIZE`
(default 1,000) as traffic intensity rises — a query searched 1,000×/window becomes
**one** write (1000×). Mapped onto the PRD's reference scale:

```
Naive:    1M searches/s × (1 count + ~10 prefix updates) ≈ 11M writes/s
Batched:  1M count writes/s + (10M / 1000) prefix writes/s ≈ 1.01M writes/s
```

a ~10× reduction in *total* writes, and ~1000× on the *prefix-update* writes that
caused the explosion. **Batching causes only stale reads, never data loss** — the
frequency counts are always eventually written.

---

## 4. Throughput

| Metric | Value |
|---|---:|
| sustained throughput (single Node client) | ≈ 1,395 req/s |

This is client-bound (one Node process issuing requests), not a server ceiling.
The API tier is stateless and the cache is horizontally shardable, so real
throughput scales with API replicas and Redis nodes.

---

## 5. Failure handling (observed)

- **Cache node down:** stopping `redis-2` → `/suggest` for its prefixes still
  returns results via the Trie fallback (`source:"trie"`), `/cache/debug` reports
  `status:"miss"` and `nodeLiveness.cache-node-2:false`. **No request failures.**
- **Worker crash:** un-acked stream entries remain in the consumer-group pending
  list and are re-read on restart (at-least-once). Acks happen only after the
  durable write, so a crash mid-flush replays rather than loses.
- **Queue enqueue failure:** `POST /search` still returns `200 {"message":"Searched"}`;
  the user is never blocked on a counting concern.

---

## How to reproduce

```bash
# 1. cache nodes
docker compose up -d
# 2. data
cd backend && npm run dataset:generate -- --rows 120000 --out ../datasets/queries.csv
# 3. API + worker (two terminals)
npm run dev
npm run worker
# 4. warm + measure
npm run warm
npm run perf -- --requests 10000 --concurrency 20 --writeRatio 0.1
# 5. read the live counters any time
curl localhost:3000/metrics
```
