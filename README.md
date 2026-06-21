# Search Typeahead System

A production-style **search autocomplete** system (like Google / e-commerce suggestions) built to
demonstrate the backend data-system design behind low-latency typeahead at scale.

It serves up to **10 prefix suggestions** sorted by popularity, records searches, distributes its cache
across multiple **Redis nodes using consistent hashing**, supports **trending (recency-aware) ranking**,
and reduces write pressure with **batched writes** via Redis Streams.

> Full design rationale lives in [`docs/PRD.md`](docs/PRD.md). This README is the operational guide:
> how to set up, run, load data, and demo the system.

---

## Table of Contents
1. [Architecture at a glance](#architecture-at-a-glance)
2. [Tech stack](#tech-stack)
3. [Repository layout](#repository-layout)
4. [Prerequisites](#prerequisites)
5. [Quick start](#quick-start)
6. [Loading the dataset](#loading-the-dataset)
7. [API reference](#api-reference)
8. [Configuration](#configuration)
9. [Demo script (for the viva)](#demo-script-for-the-viva)
10. [Performance report](#performance-report)
11. [Testing](#testing)

---

## Architecture at a glance

```
React UI ──prefix──▶ /suggest ──▶ Consistent Hash Ring ──▶ Redis node (cache)
   │                                   │ (miss)
   │                                   ▼
   │                            Augmented Trie (top-K per prefix) ◀── Count Store
   │
   └──submit──▶ /search ──▶ Redis Streams ──▶ Batch Worker ──▶ Count Store
                                                  │              │
                                                  ├─ invalidate affected suggest:* keys
                                                  └─ feed Trending Engine (decay) ──▶ /trending
```

- **Read path is O(1):** a single cache GET. The Trie is only touched on a miss or rebuild.
- **Write path is decoupled & batched:** the user is never blocked; counts are aggregated before writing.
- **Cache is distributed:** consistent hashing with virtual nodes routes each prefix to one Redis node.

See the rendered diagram and flows in [`docs/PRD.md` §11](docs/PRD.md#11-architecture-overview-hld).

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite + TypeScript |
| API | Node.js + TypeScript + Fastify |
| Cache | Redis (3 nodes) + consistent hashing |
| Queue | Redis Streams (consumer groups) |
| Suggestions | In-memory augmented Trie (precomputed top-K) |
| Infra | Docker Compose |

---

## Repository layout

```
search-typeahead-system/
├── backend/
│   └── src/
│       ├── api/        # HTTP routes: /suggest, /search, /cache/debug, /trending, /metrics
│       ├── trie/       # Augmented Trie (top-K per node)
│       ├── cache/      # Cache-aside logic, TTL, invalidation, warming
│       ├── hashing/    # Consistent hash ring + virtual nodes
│       ├── queue/      # Redis Streams producer/consumer
│       ├── workers/    # Batch worker: aggregate + flush + invalidate + trending feed
│       ├── trending/   # Decay scoring + blended ranking + trending list
│       ├── store/      # Durable count store + Trie rebuild
│       ├── metrics/    # Counters, histograms, /metrics serialization
│       ├── config/     # Env-driven configuration
│       ├── models/     # Shared types
│       └── utils/      # Normalization, logging, helpers
├── frontend/           # React app (search box, dropdown, debounce, trending)
├── scripts/            # Dataset loader/generator, cache warmer, load-test harness
├── datasets/           # Dataset files + attribution
├── docs/               # PRD, architecture, API docs, performance report
├── tests/              # Unit + integration tests
├── docker-compose.yml  # API + 3 Redis nodes + worker
└── README.md
```

---

## Prerequisites

- **Node.js** ≥ 20
- **Docker** + **Docker Compose** (for the Redis cluster and one-command run)
- ~1 GB free RAM for the Trie at 100k–1M entries

---

## Quick start

```bash
# 1. Start Redis cache nodes (3) + queue
docker compose up -d redis-0 redis-1 redis-2

# 2. Install backend deps
cd backend && npm install

# 3. Generate (or place) a dataset of >= 100k queries
npm run dataset:generate          # writes datasets/queries.csv

# 4. Start the API (loads dataset into the Trie + count store on boot)
npm run dev

# 5. In another terminal, start the batch worker
npm run worker

# 6. Start the frontend
cd ../frontend && npm install && npm run dev
```

Then open the printed frontend URL (default http://localhost:5173) and start typing.

> A single `docker compose up` that runs everything (API + worker + Redis + frontend) is provided once
> the services are containerized; see [`docker-compose.yml`](docker-compose.yml).

---

## Loading the dataset

The system needs **≥ 100,000 queries with counts**. Two options:

**A. Use the bundled generator** (Zipf-distributed synthetic queries — good for the demo):
```bash
cd backend
npm run dataset:generate -- --rows 150000 --out ../datasets/queries.csv
```

**B. Bring your own** open dataset (AOL logs, Kaggle popular queries, Wikipedia titles+pageviews):
- Format it as CSV with a header `query,count`.
- If your source has no counts, aggregate duplicates or derive frequencies.
- Place it at `datasets/queries.csv` (or pass `--file`), then:
```bash
npm run dataset:load -- --file ../datasets/queries.csv
```

Dataset source and attribution are documented in [`datasets/README.md`](datasets/README.md).

---

## API reference

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/suggest?q=<prefix>&limit=<n>` | Up to 10 prefix suggestions, sorted by score. |
| POST | `/search` | Records a search; returns `{"message":"Searched"}`. |
| GET | `/cache/debug?prefix=<prefix>` | Which cache node owns the prefix + hit/miss + ring info. |
| GET | `/trending?limit=<n>` | Recency-aware trending queries. |
| GET | `/metrics` | Cache hit ratio, DB reads/writes, latencies, write reduction. |
| GET | `/healthz` | Liveness probe. |

Full request/response schemas, status codes, and edge cases: [`docs/PRD.md` §6](docs/PRD.md#6-api-specification).

---

## Configuration

All tunables are environment variables (see [`.env.example`](backend/.env.example)). Highlights:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | API port |
| `REDIS_NODES` | `localhost:6380,localhost:6381,localhost:6382` | Cache node addresses |
| `VIRTUAL_NODES` | `150` | Virtual nodes per physical node on the ring |
| `CACHE_TTL_SUGGEST_MS` | `60000` | TTL for `suggest:<prefix>` entries |
| `BATCH_SIZE` | `1000` | Flush batch when this many entries accumulate |
| `FLUSH_INTERVAL_MS` | `2000` | Flush at least this often |
| `TRENDING_ALPHA` | `0.7` | Weight of historical vs recent in ranking |
| `TRENDING_DECAY` | `0.9` | Per-period decay factor for recent activity |
| `TOP_K` | `10` | Max suggestions per prefix |

---

## Demo script (for the viva)

1. **Suggestions:** type `iph` → dropdown shows iphone, iphone 15, … sorted by count.
2. **Consistent hashing:** `GET /cache/debug?prefix=iph` → shows owning node + hit/miss; query a few
   prefixes and show they land on different nodes.
3. **Search + counts:** `POST /search {"query":"iphone 17"}` repeatedly, then watch it climb suggestions.
4. **Batch writes:** show `/metrics` — `writes_avoided_total` and `db_writes_total` prove the reduction.
5. **Trending:** spam a fresh query, then `GET /trending` shows it rising; wait and show it decaying.
6. **Failure handling:** stop `redis-2`, repeat `/cache/debug` for its keys → they reroute to another node.

---

## Performance report

A load-test harness (`scripts/perf.ts`) measures p50/p95/p99 suggest latency, cache hit ratio, and
write reduction. Results and methodology: [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

```bash
cd backend
npm run warm                                  # warm the cache for a representative hit ratio
npm run perf -- --requests 10000 --concurrency 20 --writeRatio 0.1
```

Headline measured results (120k-query dataset, 3 Redis nodes):

| Metric | Result | Target |
|---|---|---|
| Suggest latency p50 / p95 / p99 (server-side) | 3.3 / 6.8 / 9.2 ms | p99 < 10 ms |
| Cache hit ratio | ~98% | ≥ 90% |
| Write reduction (mixed load) | ~43× (→ 1000× as a hot query saturates a batch window) | ≥ 100× |

## Documentation

| Doc | Contents |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | Full product requirements, design rationale, architecture, LLD. |
| [`docs/API.md`](docs/API.md) | Every endpoint: params, responses, status codes, edge cases. |
| [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) | Measured latency, hit ratio, write reduction + how to reproduce. |
| [`docs/VIVA.md`](docs/VIVA.md) | One-page defense of every design choice for the viva. |
| [`datasets/README.md`](datasets/README.md) | Dataset format, generator, and bring-your-own instructions. |

---

## Testing

```bash
cd backend
npm test            # unit + integration (trie, hashing, batching, cache, ranking, api)
```

---

## License / Academic note

Built for an HLD course assignment. Design inspired by standard typeahead architectures; all code and
explanations are original. See [`docs/PRD.md`](docs/PRD.md) for the full design rationale and trade-offs.
