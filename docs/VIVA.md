# Viva Crib Sheet

One page to defend every major decision. Each answer is something you can say in
your own words and back up by pointing at the code.

---

## The one-sentence pitch
> Suggestions are a **precomputed top-K cache keyed by prefix**, distributed across
> Redis nodes with **consistent hashing**; searches are recorded **asynchronously
> and batched** to survive write-heavy load; ranking blends all-time popularity with
> an **exponentially-decayed recency** signal for trending.

---

## Why these choices

**Why a Trie?**
O(L) prefix navigation, and we augment each node with a precomputed top-K so a read
returns an answer in O(K) with no subtree traversal. → `backend/src/trie/Trie.ts`

**Why cache the top-K per prefix instead of traversing the Trie each request?**
Reads dominate (every keystroke). A precomputed `suggest:<prefix>` entry turns each
read into a single Redis `GET` (~1 ms) and scales horizontally. The Trie is only the
miss/rebuild path. → `backend/src/api/SuggestService.ts`

**The system is read- AND write-heavy. How do you cope?**
Reduce writes. Counting every search is the floor (1 write each), but updating the
top-K of every prefix on every search is the explosion (~11M writes/s at 1M qps).
**Batching** collapses repeated queries into one write per flush window; optional
**sampling** processes only a fraction of events. → `backend/src/workers/`

**Does batching lose data?**
No. Counts are always eventually written; only the *derived* suggestion view lags,
so you get **stale reads, not lost data**. (Sampling *does* drop events, but uniform
sampling preserves aggregate trends, and dropped rare queries weren't top-K anyway.)

**Why consistent hashing, not `hash(key) % N`?**
Modulo remaps almost every key when N changes (node added/removed) → cache-wide miss
storm. Consistent hashing only disturbs ~1/N of keys. → `ConsistentHashRing.ts`
(test proves it: removing 1 of 3 nodes moves only the keys that were on that node).

**Why virtual nodes?**
With few physical nodes the ring is lumpy and removing one dumps its whole arc on a
single neighbor. ~150 vnodes/node spread load evenly and make redistribution
fractional. (Distribution test: 30k keys split ≈ 33/33/33.)

**Why Redis Streams for the queue (not BullMQ / in-memory)?**
Durable append-only log + consumer groups (pending list for crash recovery), and no
new infra since we already run Redis. In-memory loses data on crash; BullMQ adds
concepts we don't need. → `backend/src/queue/`, `backend/src/workers/BatchWorker.ts`

**How does trending reward recency without over-ranking a one-day spike?**
`recentScore` decays exponentially each period (×0.9), so a spike fades
geometrically (0.9, 0.81, 0.729…) while sustained queries keep getting topped up.
Final rank blends normalized total + recent. → `backend/src/trending/TrendingEngine.ts`
(test: a 500-count recent query outranks a 5,000,000 all-time query, then fades.)

**How is the cache invalidated when rankings change?**
On each flush the worker recomputes the affected prefixes' top-K and **writes them
through** into the cache; TTL is the passive backstop. We write-through (not just
delete) because the API has a separate Trie and would otherwise refill the key with
stale data. → `BatchWorker.flush()`

---

## Likely "gotcha" questions

**Q: The API and worker are separate processes with separate Tries — how do
suggestions stay correct?**
The shared Redis cache is the cross-process serving surface. The worker (which has
the live counts) writes fresh top-K + trending into the cache; the API just serves
whatever the cache holds. See PRD §12.1.

**Q: What if a cache node dies?**
The request degrades to a miss and rebuilds from the Trie — no outage. `/cache/debug`
shows the dead node and the miss. (Auto-eviction from the ring for true rerouting is
a noted future improvement.)

**Q: At-least-once means possible double counts?**
Yes, rarely, only if a crash happens between the durable write and the ack. Acceptable
under the eventual-consistency NFR; a processed-offset would make it exactly-once.

**Q: Why is 1 write/search the floor?**
You must at least count each search to know popularity. You can only go below that by
sampling (which trades exactness for fewer writes).

**Q: What happens if the queue Redis goes down?**
`POST /search` still returns `200 {"message":"Searched"}` immediately — the enqueue is
**fire-and-forget**, so the user path stays fast (~0.2s) even during the outage. The
failed enqueues are counted (`enqueue_errors_total`) and those counts are lost
(acceptable under eventual consistency). When Redis returns, recording resumes.

**Q: What if the worker crashes, or the stream/consumer group disappears?**
The worker loop has an error boundary: it never dies on a transient error. On
`NOGROUP` (stream/group evicted or flushed) it **recreates the group and continues**.
On a genuine crash, un-acked entries remain in the consumer-group **pending list** and
are redelivered on restart — and we **XACK only after the durable write**, so recovery
is at-least-once with no lost counts. (These two behaviors were hardened after QA
found the worker could otherwise die silently — see `docs/QA-REPORT.md`.)

**Q: The API and worker have separate Tries — how do you avoid serving stale empties?**
The API never caches an **empty** suggestion result. For a query only the worker has
seen, the API's Trie returns `[]`; caching that would clobber the worker's
write-through. By skipping empty writes, the worker's fresh top-K wins. (Also a
QA-hardened fix.)

---

## Numbers to quote (see PERFORMANCE.md)
- Suggest p50/p95/p99 = **3.3 / 6.8 / 9.2 ms** (server-side).
- Cache hit ratio = **~98 %**.
- Write reduction = **~43×** in mixed load; → **1000×** as a hot query saturates a
  batch window (`BATCH_SIZE`).
- Dataset = **120,000** queries.
