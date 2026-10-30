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

## Searching inside `Message.value` (JSONB containment)

"Every message that mentions object X" is an index lookup. `Message.value`
has an ordinary GIN index (`Message_value_gin_idx`, `jsonb_path_ops`, defined
in ixo-blocksync's migrations), so `value: { contains: … }` uses it as written:

```graphql
query MessagesMentioning($id: String!) {
  messages(filter: { value: { contains: { id: $id } } }, first: 100, orderBy: ID_DESC) {
    totalCount
    nodes { id typeUrl transactionHash transactionByTransactionHash { height time } }
  }
}
```

- Shapes that use the index: `{ id: "<did>" }`, `{ entity: "<did>" }`,
  `{ collectionId: "<id>" }`, and `{ msgs: [{ id: "<did>" }] }` for messages
  wrapped in an authz `MsgExec`. Only `contains` is indexed; `containsKey` and
  `containsAllKeys` on `Message.value` are not.
- **`/ibc.core.client.v1.MsgUpdateClient` is not in `Message`.** Since
  ixo-blocksync v2.16.0 (2026-10-30, Linear IXO-5906) the indexer skips these
  IBC light-client headers (86% of the table's bytes on mainnet) and the rows
  already stored were removed; the raw messages stay in blocksync-core and on
  chain. An IBC relay transaction therefore lists one message fewer than on
  chain. Earlier the index was partial and every containment query had to add
  `typeUrl: { notEqualTo: "/ibc.core.client.v1.MsgUpdateClient" }`; that
  clause is no longer needed and still works if sent.
- Batch several objects in one document with aliases (HTTP query batching is
  not available, see below).
- Every GraphQL transaction runs with `plan_cache_mode = force_custom_plan`
  (`src/preset.ts`), so Postgres plans each statement with its bind values. A
  generic plan cannot estimate how selective a `$n` containment value is and
  walks the primary key with a filter instead of using the index. The
  `blocksync` role carries the same setting in all three environments as a
  backstop.
- Measured on mainnet after the change (2026-10-30, 1.35M messages): about
  0.3 s end to end without any `typeUrl` clause; before it, the same query
  hit the 8 s statement timeout.
- Limit: GIN containment finds every match before ordering, so "newest N
  messages mentioning X" is slow for an X that hundreds of thousands of
  messages mention (for example mainnet claim collections 5 and 6). A
  message-references table with an exact lookup is planned for that (Linear
  IXO-5676).

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
  cache or `BYPASS` for uncacheable operations; `gql.errors` (boolean) flags
  any GraphQL error, including partial failures where `data` is returned
  alongside an `errors` array.
- When execution produced errors, the line also carries `gql.errorCount`,
  `gql.errorCodes` (distinct codes, max 5 — the Postgres SQLSTATE for
  database errors, e.g. `57014` statement timeout, otherwise
  `extensions.code`, else `unknown`), `gql.errorPath` (first error's path,
  dot-joined) and `gql.errorMessage` (first error's message, ≤160 chars).
  These come from the execution result (`RequestErrorsPlugin`,
  `src/plugins/request-errors.ts`) because grafast serialises `data` before
  `errors`, so the response body's first bytes can't reveal a partial
  failure. Requests rejected before execution (parse/validation errors, 400)
  set only `gql.errors`, detected from the start of the response body.
  Stacks are never logged. Example (truncated):
  `"gql":{…,"errors":true,"errorCount":1,"errorCodes":["57014"],"errorPath":"claimCollections","errorMessage":"canceling statement due to statement timeout"}`
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
