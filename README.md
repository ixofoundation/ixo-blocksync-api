# ixo-blocksync-api

Read-only, horizontally-scalable query API for the ixo blocksync database.

This service is the **query half** of what used to be a single `ixo-blocksync`
process: [ixo-blocksync](https://github.com/ixofoundation/ixo-blocksync) keeps
indexing the chain into Postgres (writes), while `ixo-blocksync-api` serves
GraphQL + REST reads from that same database. Because it holds no sync state,
you can run as many replicas as you need.

Built on **PostGraphile 5** (Grafast) with the V4 compatibility preset, so the
GraphQL schema keeps the exact field names, arguments and response shapes of
the existing `ixo-blocksync` v4 GraphQL API.

## Endpoints

| Path | Description |
| --- | --- |
| `POST /graphql` | GraphQL API (same schema shape as ixo-blocksync) |
| `GET /graphiql` | Ruru (GraphiQL) with Grafast plan visualisation |
| `GET /graphql/schema.graphql` | Exported SDL (written on boot) |
| `GET /api/claims/collection/:id/claims` | Paginated collection claims (same contract as ixo-blocksync) |
| `GET /api/ipfs/:cid` | Rate-limited IPFS gateway proxy |
| `GET /` | Plain liveness text ("API is Running") |
| `GET /healthz` | Liveness with a DB round-trip |

## Configuration

Copy `.env.example` to `.env`. `DATABASE_URL` is the only required variable —
point it at the blocksync database (read access is enough; the API never
writes).

Notes:

- `DATABASE_USE_SSL=1` connects with `rejectUnauthorized: false` to match how
  ixo-blocksync connects to the managed cluster. Prefer proper CA validation
  where possible.
- **pgbouncer**: the pool intentionally avoids server startup parameters
  (pgbouncer rejects them) - query timeouts are client-side plus per-request
  `SET LOCAL` inside transactions. LISTEN/NOTIFY does not traverse pgbouncer
  transaction pooling, so set `BLOCK_CACHE_LISTEN_DATABASE_URL` to the direct
  postgres service for instant cache invalidation; without it the poll
  backstop (default 3s) bounds staleness instead.
- `RPC` is only needed for the `tokenomicsSupply*` GraphQL fields (they read
  the chain, not the DB).
- **Block-aware response cache** (`BLOCK_CACHE`, default on): GraphQL POST
  responses are cached in-process and the entire cache is flushed the moment
  the indexer commits a block (pg_notify trigger on `"Chain"` - apply
  `scripts/block-notify-trigger.sql` once per database - plus a
  `BLOCK_CACHE_BACKSTOP_MS` poll as a safety net). Because the database only
  changes when a block commits, a cached response can never be staler than
  the database itself: someone who transacts and immediately queries still
  sees their transaction, since that block flushed the cache. Mutations
  (none exist), `tokenomics*` operations (chain-RPC backed) and responses
  over `BLOCK_CACHE_MAX_ENTRY_BYTES` are never cached. `X-Cache: HIT|MISS`
  is set on cacheable requests; `/healthz` reports cache stats.

## Request analytics logging

Every request (except `/` and `/healthz` probes) emits one structured JSON
line on stdout via [pino](https://github.com/pinojs/pino), ready for any log
pipeline (Loki/Grafana, BigQuery, `kubectl logs | jq`):

```json
{"level":"info","time":"2026-07-11T09:00:00.000Z","method":"POST","path":"/graphql","status":200,"durationMs":43.2,"bytes":26543,"ip":"1.2.3.4","ua":"node-fetch","gql":{"op":"GetEntityById","type":"query","roots":["entity"],"hash":"ab12cd34ef56ab12","cache":"HIT","errors":false},"msg":"request"}
```

- `gql.roots` are the operation's top-level fields — the natural dimension for
  per-resolver latency/volume aggregation; `gql.hash` (sha256 of the query
  text) groups identical documents; `gql.cache` is `HIT`/`MISS` from the block
  cache or `BYPASS` for uncacheable operations; `gql.errors` flags GraphQL
  errors (headers-based heuristic — errors precede data in the payload).
- `bytes` is the uncompressed response size (logging sits inside
  compression). Variables are deliberately never logged.
- Responses with status ≥ 400 and requests slower than `LOG_SLOW_MS`
  (default 1s) log at `warn`, 5xx at `error`, so slow/failing traffic can be
  alerted on by level alone.
- `LOG_LEVEL` controls verbosity (`silent` disables). Pretty-print locally
  with `npm run dev | npx pino-pretty`.

## Run

```bash
npm install
npm run dev        # tsx watch
npm run build && npm start
```

## Intentional differences from the ixo-blocksync API surface

- **No GraphQL query batching** (array-of-operations POST bodies). Removed in
  PostGraphile 5; no known ixo client uses it (verified against impacts-x-web,
  jambo, ixo-Mobile and ixo-matrix-appservice-rooms, July 2026). Use HTTP/2 or
  merge queries into one document with aliases.
- **`nodeId` and connection cursor encodings differ** from v4. Field names and
  shapes are unchanged; only the opaque values differ, so don't persist them
  across the migration.
- `/api/ipfs/:cid` serves non-inline-safe content types (e.g. `image/svg+xml`,
  XML) as `application/octet-stream` with `nosniff` + a sandboxing CSP, so
  proxied IPFS content can never execute scripts on the API origin (v4 only
  blocked `text/html`). Common image/json/pdf types are unaffected.
- `/api/claims/...` no longer triggers the cellnode schema-type fetch (that is
  a write; the indexer's cron owns it). The "not loaded yet" response contract
  is unchanged.
- No `/ws` websocket server (it belongs to the indexer, which sees new blocks),
  no swagger, no write/cron endpoints (`/api/tokenomics/fetchAccounts` stays on
  the indexer).
- No Sentry yet — add the org-standard Sentry setup at deploy time if wanted.
