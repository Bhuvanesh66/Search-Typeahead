# API Documentation

Base URL (dev): `http://localhost:3000` (frontend calls it via the `/api` proxy).

All inputs are normalized server-side: **trim → lowercase → collapse internal
whitespace → Unicode NFC**. The same normalizer is used on the write path, so
prefix matching is always consistent.

---

## `GET /suggest`

Return up to 10 prefix suggestions, sorted by score descending.

**Query parameters**

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `q` | string | yes | — | The prefix. 0–100 chars (truncated beyond). |
| `limit` | int | no | 10 | Clamped to 1–10. |

**200 OK**
```json
{
  "prefix": "iph",
  "suggestions": [
    { "query": "iphone portable guide", "count": 45449, "score": 45449 },
    { "query": "iphone max amazon 174", "count": 21286, "score": 21286 }
  ],
  "source": "cache",
  "node": "cache-node-0",
  "latencyMs": 1.96
}
```
- `source`: `"cache"` (hit), `"trie"` (miss → computed → cached), or `"empty"`.
- `node`: the cache node that owns this prefix on the ring.

**400 Bad Request** — missing `q` parameter.

**Edge cases**
| Input | Result |
|---|---|
| `q=""` (empty) | `200`, `suggestions: []`, `source:"empty"` |
| `q` missing entirely | `400` |
| `q=Zzz` (no match) | `200`, `suggestions: []` |
| `q=IpHoNe` (mixed case) | matched case-insensitively |
| `q="  iphone  "` | trimmed before matching |

---

## `POST /search`

Record a submitted search and return a dummy response. The query is enqueued for
asynchronous, batched counting — the response returns immediately.

**Request body**
```json
{ "query": "iphone 15" }
```

**200 OK**
```json
{ "message": "Searched" }
```

**400 Bad Request** — missing or empty `query`.

**Notes**
- Never blocks on the write. If the queue is unavailable, the user still gets
  `200`; the failure is counted in `/metrics` (counting must not fail the search).
- Repeated identical queries are aggregated before the durable write.

---

## `GET /cache/debug`

Show how a prefix is routed on the consistent-hash ring and whether it is cached.
Built for demonstrating consistent hashing in the viva.

**Query parameters**

| Name | Type | Required |
|---|---|---|
| `prefix` | string | yes |

**200 OK**
```json
{
  "prefix": "iphone",
  "normalizedKey": "suggest:iphone",
  "owningNode": "cache-node-0",
  "virtualNodeHit": "cache-node-0#5",
  "status": "hit",
  "ttlRemainingMs": 59388,
  "ringPosition": 40048146,
  "ringDistribution": { "cache-node-0": 150, "cache-node-1": 150, "cache-node-2": 150 },
  "nodeLiveness": { "cache-node-0": true, "cache-node-1": true, "cache-node-2": true }
}
```

**400 Bad Request** — missing `prefix`.

---

## `GET /trending`

Recency-aware trending queries. Served from the shared `trending` cache key
(published by the worker); falls back to popularity ordering on a cold cache.

**Query parameters**

| Name | Type | Required | Default |
|---|---|---|---|
| `limit` | int | no | 20 |

**200 OK**
```json
{
  "trending": [
    { "query": "live event 2026", "totalCount": 40, "recentScore": 21.26, "blendedScore": 0.30 },
    { "query": "flight air shop", "totalCount": 1017481, "recentScore": 0, "blendedScore": 0.70 }
  ]
}
```
- `recentScore`: exponentially-decayed recent activity. A burst raises it; decay
  fades it over time, so a short spike does not dominate forever.

---

## `GET /metrics`

Operational snapshot: counters, gauges, latency percentiles, and derived ratios
(cache hit ratio, write reduction). Worker-side write counters are merged in.

**200 OK** (abridged)
```json
{
  "counters": { "cache_hits_total": 8938, "cache_misses_total": 187,
                "searches_seen_total": 1331, "db_writes_total": 31 },
  "gauges": { "trie_size": 120000, "queue_depth": 0 },
  "latencies": { "search_latency_ms": { "p50": 3.31, "p95": 6.77, "p99": 9.23 } },
  "derived": { "cache_hit_ratio": 0.9795, "writes_avoided_total": 1300,
               "write_reduction_factor": 42.94 }
}
```

---

## `GET /healthz`

Liveness probe. `200 OK` → `{ "status": "ok", "trieSize": 120000 }`.
