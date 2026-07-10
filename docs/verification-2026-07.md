# Verification against ixo-blocksync v4 (July 2026)

Method: mainnet `blocksync_alt` dumped (read-only) and restored into local
Postgres 15 (same major as prod). ixo-blocksync v4.13 (indexing disabled) and
ixo-blocksync-api served the SAME database side by side. All GraphQL operations
extracted from the four production clients (impacts-x-web 73, ixo-Mobile 25+4,
jambo 9, ixo-matrix-appservice-rooms 7) were replayed against both endpoints
with real mainnet fixture values and JSON-diffed.

## Correctness (114 operations)

| Verdict | Count | Meaning |
| --- | --- | --- |
| MATCH | 108 | byte-identical data (opaque `nodeId`/cursor values excluded by design) |
| ORDER_DIFF | 3 | identical row sets; rows tied on the orderBy value return in different order. Cursor pagination verified stable (no dupes/gaps) on both engines |
| BOTH_ERROR | 3 | identical errors on both: 2 corpus-extraction artifacts + 1 pre-existing client bug (impacts-x-web `claimsProcessedToDate` queries `evaluationByClaimIdExists`, which does not exist in the v4 schema either) |

Schema: 534 types on both; the only structural deltas are in the (client-unused)
aggregates corner - `keys: [String]` vs `[String!]` nullability metadata on the
3 *Aggregates types, and v5 omitting aggregate orderBy enum values over text
columns that v4 offered but which error in SQL if used (e.g. `avg(text)`).

REST: `GET /api/claims/collection/:id/claims` (with and without type filter)
byte-identical; `GET /api/ipfs/:cid` same status/content-type/bytes.

## Latency (n=50 warm, sequential, local PG15, prod-mode processes)

| Query (client) | v4 p50 | v5 p50 | speedup |
| --- | --- | --- | --- |
| AllTypesEntities (portal boot) | 611ms | 279ms | 2.2x |
| SubmittedClaims (60s poller) | 57ms | 29ms | 2.0x |
| getAllClaimsByCollectionId (jambo) | 3.07s | 2.19s | 1.4x |
| GetAccountImpactTokens (mobile) | 242ms | 212ms | 1.1x |
| TransactionsByWalletAddress* (60s poller) | 3.5ms | 4.2ms | ~1x (index win, see below) |
| GetDIDDocument (UCAN middleware) | 2.7ms | 2.7ms | parity |
| small lookups (2-6ms class) | - | - | parity +-10% |

Under concurrency (20 parallel): GetDIDDocument 1.3x, Entity 1.5x faster on v5;
p95s consistently tighter on v5.

*TransactionsByWalletAddress was 132ms (v4) / 103ms (v5) before the recommended
indexes below - they take it to ~4ms on BOTH engines.

## Recommended indexes (add to ixo-blocksync migrations; tested on mainnet copy)

```sql
-- 60s wallet poller: or:[{from},{to}] filters had no standalone index
CREATE INDEX "Message_from_idx" ON "Message"("from") WHERE "from" IS NOT NULL;  -- 132ms -> 4ms
CREATE INDEX "Message_to_idx" ON "Message"("to") WHERE "to" IS NOT NULL;
CREATE INDEX "Message_typeUrl_idx" ON "Message"("typeUrl");                     -- token stats queries
CREATE INDEX "TokenRetired_id_idx" ON "TokenRetired"("id");                     -- allEntityRetired sums
CREATE INDEX "Claim_collectionId_submissionDate_idx"
  ON "Claim"("collectionId", "submissionDate" DESC, "claimId");                 -- claim pagination
```

## Client-side findings (no client code was changed)

- impacts-x-web `claimsProcessedToDate` uses a field that does not exist
  (`evaluationByClaimIdExists` -> should be `evaluationsByClaimIdExist` or
  `evaluationExists`) - broken today on v4 too.
- jambo `getAllClaimsByCollectionId` and impacts-x-web
  `SubmittedClaimsByCollectionId`/`ClaimCollection` fetch entire collections
  unpaginated (2-6s on big collections on either engine) - should paginate.
- No client uses GraphQL query batching (safe to drop in v5) and none persists
  nodeIds/cursors across sessions.
