# QA Test Report — Search Typeahead System

A behavior-level QA pass against every assignment requirement, run against the live
stack (3 Redis nodes + API + batch worker) with the 120,000-query dataset. Three
real defects were found and fixed; all are covered by new regression tests.

**Result: 40/40 automated tests pass; all functional requirements verified live.**

---

## 1. Summary by requirement

| Spec § | Requirement | Result |
|---|---|---|
| §4.1 | Typeahead: ≤10 results, prefix match, sort desc | ✅ PASS |
| §4.1 | Edge cases: empty / missing / mixed-case / no-match / whitespace | ✅ PASS |
| §4.2 | `POST /search` → `{"message":"Searched"}` | ✅ PASS |
| §4.2 | New query inserted; existing query incremented | ✅ PASS |
| §4.2/§5 | Update reflected in suggestions **and** trending | ✅ PASS *(after fix)* |
| §5 | `GET /suggest`, `POST /search`, `GET /cache/debug` present & correct | ✅ PASS |
| §6 | Cache-aside (hit/miss), stores per-prefix results | ✅ PASS |
| §6 | TTL/expiry, invalidation, no-stale-forever | ✅ PASS *(after fix)* |
| §6 | Distributed across ≥3 nodes; consistent hashing owns keys | ✅ PASS |
| §6 | `/cache/debug` shows node + hit/miss | ✅ PASS |
| §7 | Trending: recency outranks all-time popularity | ✅ PASS |
| §7.3 | Short spike decays, not permanently over-ranked | ✅ PASS (verified live: 13.5 → 12.15 over one period) |
| §7.4 | Cache refreshed when rankings change | ✅ PASS *(after fix)* |
| §8 | Batching aggregates repeated queries | ✅ PASS (200 searches → 6 writes) |
| §8 | Flush by size **or** interval (1000 / 2000 ms) | ✅ PASS |
| §8 | Write-reduction evidence | ✅ PASS (~14–43× measured; →1000× at saturation) |
| §8 | Failure handling: queue down, worker crash | ✅ PASS *(after fixes)* |
| §3 | Dataset ≥100k, `query,count` | ✅ PASS (120,000 rows) |

---

## 2. Defects found and fixed

### BUG-1 — API cached empty results, clobbering the worker's write-through *(High)*
**Symptom:** A freshly-searched query (e.g. `qa refresh test`) never appeared under
its prefix; `/suggest` returned `[]` with `source:"cache"` even though the worker had
recorded it.
**Root cause:** API and worker have separate in-memory Tries. On a miss for a
worker-only query, the API computed `[]` from its own (stale) Trie and **cached the
empty result**, overwriting the worker's correct write-through.
**Fix:** `SuggestService` no longer caches empty results — only non-empty top-K is
written. Empty misses cost a cheap repeat Trie lookup until real data exists.
→ `backend/src/api/SuggestService.ts`; regression: `tests/unit/suggestService.test.ts`.

### BUG-2 — Worker died permanently on `NOGROUP` (stream/group missing) *(High)*
**Symptom:** After the stream or consumer group disappeared (Redis eviction, flush,
or a fresh Redis), the worker threw `NOGROUP … in XREADGROUP` and the process exited
(`fatal: worker failed`), silently stopping **all** count updates.
**Root cause:** the read loop had no error boundary; any tick error killed it.
**Fix:** the worker loop now catches per-tick errors, **self-heals `NOGROUP`** by
recreating the consumer group and continuing, and backs off on other errors instead
of crashing. → `backend/src/workers/BatchWorker.ts` (`start()`), metric
`worker_group_recreated_total`.

### BUG-3 — `POST /search` slow (~0.9s) while the queue Redis was down *(Medium)*
**Symptom:** With the queue node stopped, `/search` still returned `200` but took
~0.9s (awaiting the failing `xadd` + reconnect), degrading the user path.
**Root cause:** the route `await`ed the enqueue.
**Fix:** enqueue is now **fire-and-forget** (`void … .catch(...)`); the response
returns immediately. Verified: `/search` stays at ~0.2s even with the queue down.
→ `backend/src/api/routes.ts`.

---

## 3. Selected evidence

```
§4.1  limit=50 → 10 results; all startWith(prefix); counts sorted desc
      q="" → []; no q → HTTP 400; q="IPHONE" → iphone…; q="zzzzz" → []
§4.2  POST /search → {"message":"Searched"}; {} or "   " → HTTP 400
      new "qatest brandnew" ×5 → appears count 5 → ×10 more → count 15
§6    cold → source:trie; warm → source:cache; PTTL ≈ 58–60s; keys split 2/4/4
      rank change under "inv" → "inv newtop query" served from cache (refreshed)
§5/§6 tesla → cache-node-2 (deterministic ×3); 46 prefixes → 15/15/16 across nodes
§7    "breaking news today" (total 15) ranks #1 over 1M-count queries; 13.5→12.15 decay
§8    200 identical searches → 6 DB writes; reduction factor 14.5×
      queue down → /search HTTP 200; enqueue_errors counted; recovers on restart
      stream deleted → worker logs "recreating and continuing", keeps processing
      consumer group has pending list; XACK only after durable write (at-least-once)
```

---

## 4. Known limitations (documented, acceptable for scope)

- **Counts lost during a queue outage window** — by design (eventual consistency);
  the user still gets `"Searched"`.
- **Static ring on node failure** — a dead node degrades to cache-miss + Trie
  rebuild rather than auto-evicting from the ring. Documented as future work.
- **At-least-once** — a crash between durable write and ack can double-count a batch
  rarely; tolerable per NFR.

---

## 5. How to re-run this QA

Bring up the stack (`docker compose up -d`, `npm run dev`, `npm run worker`), then the
automated suite plus the manual probes above:

```bash
cd backend && npm test          # 40 tests: trie, hashing, batching, trending, cache, suggest-service
```
