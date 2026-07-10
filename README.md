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
