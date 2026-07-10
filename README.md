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
- There is **no response caching**: clients get fresh data on every request
  (a transaction indexed by ixo-blocksync is visible on the very next query).

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
- `/api/claims/...` no longer triggers the cellnode schema-type fetch (that is
  a write; the indexer's cron owns it). The "not loaded yet" response contract
  is unchanged.
- No `/ws` websocket server (it belongs to the indexer, which sees new blocks),
  no swagger, no write/cron endpoints (`/api/tokenomics/fetchAccounts` stays on
  the indexer).
- No Sentry yet — add the org-standard Sentry setup at deploy time if wanted.
