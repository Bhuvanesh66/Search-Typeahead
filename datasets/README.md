# Datasets

The system needs a `query,count` dataset of **≥ 100,000 rows**.

## Format

CSV with a header row:

```csv
query,count
iphone,100000
iphone 15,85000
iphone charger,60000
java tutorial,40000
```

- `query` — the search text. Normalized on load (lowercased, trimmed, whitespace
  collapsed). May be quoted if it contains a comma.
- `count` — non-negative integer popularity/frequency.

## Option A — Bundled generator (default for the demo)

A reproducible generator synthesizes plausible multi-word queries with a
heavy-tailed (Zipf-like) popularity distribution, easily exceeding 100k unique
rows:

```bash
cd ../backend
npm run dataset:generate -- --rows 120000 --out ../datasets/queries.csv
```

The distribution mimics real search traffic (a few very popular queries, a long
tail of rare ones), so ranking and trending behave realistically.

## Option B — Bring your own open dataset

Any of these work once formatted as `query,count`:

- **AOL search logs** — aggregate identical queries to derive counts.
- **Kaggle "popular search queries" datasets** — often already have counts.
- **Wikipedia page titles + pageviews** — titles as "queries", views as "counts".
- **E-commerce product names / catalog titles** — with sales or view counts.

If your source has no counts, derive them by aggregating duplicate occurrences, or
assign a Zipf distribution by rank.

Place the file here and load/validate it:

```bash
cd ../backend
npm run dataset:load -- --file ../datasets/queries.csv
```

## Attribution

If you use an external dataset, record its source and license here:

- Source: _<url / name>_
- License: _<license>_
- Retrieved: _<date>_
- Preprocessing: _<how counts were derived, if applicable>_

> The generated `queries.csv` is synthetic and carries no third-party license.
