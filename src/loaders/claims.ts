import { pool } from "../db.js";

// ---------------------------------------------------------------------------
// Ported from ixo-blocksync src/postgres/claim.ts (read paths) +
// src/handlers/claims_handler.ts.
//
// Read-only divergence: ixo-blocksync's REST handler actively fetches missing
// claim schemaTypes from cellnode (a DB write) before answering. This API is
// read-only - when schemaTypes are still loading it returns the same
// "not loaded" response and relies on the indexer's cron to heal the data.
// ---------------------------------------------------------------------------

export type Claim = Record<string, any>;

const getCollectionClaimsTypeNullSql = `
SELECT c."claimId"
FROM "ClaimCollection" AS cc
INNER JOIN "Claim" AS c ON cc."id" = c."collectionId"
WHERE cc.id = $1 AND c."schemaType" IS NULL
LIMIT $2;
`;
const getCollectionClaimsTypeNull = async (
  collectionId: string,
  length: number
): Promise<{ claimId: string }[]> => {
  const res = await pool.query(getCollectionClaimsTypeNullSql, [
    collectionId,
    length,
  ]);
  return res.rows;
};

// ClaimCollection.claimSchemaTypesLoaded, batched over every collection id in
// the request (ixo-blocksync runs one query per collection here; batching is
// a pure improvement with identical per-collection results).
const collectionsWithNullSchemaTypeSql = `
SELECT DISTINCT "collectionId" AS id
FROM "Claim"
WHERE "collectionId" = ANY($1::text[]) AND "schemaType" IS NULL;
`;
export const batchClaimSchemaTypesLoaded = async (
  ids: ReadonlyArray<any>
): Promise<boolean[]> => {
  if (!ids.length) return [];
  const res = await pool.query(collectionsWithNullSchemaTypeSql, [
    ids as string[],
  ]);
  const notLoaded = new Set(res.rows.map((r: { id: string }) => r.id));
  return ids.map((id) => !notLoaded.has(id));
};

// cant have asc or desc as query parameter, so use direct string interpolation
// (identical SQL to ixo-blocksync getCollectionClaimsByType)
const getCollectionClaimsByTypeSql = (orderBy: "asc" | "desc") => `
SELECT c.*,
      CASE WHEN ev."claimId" IS NULL THEN NULL
      ELSE jsonb_build_object(
        'collectionId', ev."collectionId",
        'oracle', ev."oracle",
        'agentDid', ev."agentDid",
        'agentAddress', ev."agentAddress",
        'status', ev."status",
        'reason', ev."reason",
        'verificationProof', ev."verificationProof",
        'amount', ev."amount",
        'evaluationDate', ev."evaluationDate"
      )
      END AS "evaluation"
FROM "Claim" c
LEFT JOIN "Evaluation" AS ev ON c."claimId" = ev."claimId"
WHERE c."collectionId" = $1
  AND (
    ($2::boolean IS NULL) OR /* No type filter */
    ($3::text IS NOT NULL AND c."schemaType" = $3::text) OR /* With non-null type */
    ($3::text IS NULL AND c."schemaType" IS NULL) /* With null type */
  )
  AND (
    ($4::boolean IS NULL) OR /* No status filter */
    (($5::smallint IS NULL OR $5::smallint = 0) AND ev."claimId" IS NULL) OR /* Unevaluated */
    (ev."claimId" IS NOT NULL AND ev."status" = $5::smallint) /* Evaluated with specific status */
  )
  /* pagination below */
  AND (
    $8::text IS NULL OR /* No claimId cursor */
    CASE $6::text
      WHEN 'desc' THEN ( /* Descending order */
        c."submissionDate" < (SELECT c2."submissionDate" FROM "Claim" c2 WHERE c2."claimId" = $8::text) OR
        (c."submissionDate" = (SELECT c2."submissionDate" FROM "Claim" c2 WHERE c2."claimId" = $8::text) AND c."claimId" < $8::text)
      )
      ELSE /* ASC(Ascending order) or Invalid order (default to ASC) */
        (
          c."submissionDate" > (SELECT c2."submissionDate" FROM "Claim" c2 WHERE c2."claimId" = $8::text) OR
          (c."submissionDate" = (SELECT c2."submissionDate" FROM "Claim" c2 WHERE c2."claimId" = $8::text) AND c."claimId" > $8::text)
        )
    END
  )
ORDER BY c."submissionDate" ${orderBy}, c."claimId" ${orderBy}
LIMIT $7
`;

const getCollectionClaimsByType = async (p: {
  collectionId: string;
  includeType: boolean;
  type: string | null;
  includeStatus: boolean;
  status: number | null;
  orderBy: "asc" | "desc";
  take: number;
  cursor: string | null;
}): Promise<Claim[]> => {
  const res = await pool.query(getCollectionClaimsByTypeSql(p.orderBy), [
    p.collectionId,
    p.includeType || null,
    p.type,
    p.includeStatus || null,
    p.status,
    p.orderBy,
    p.take,
    p.cursor,
  ]);
  return res.rows;
};

// GET /api/claims/collection/:id/claims - same response contract as
// ixo-blocksync ClaimsHandler.getCollectionClaims.
export const getCollectionClaims = async (
  id: string,
  status?: string,
  type?: string,
  take?: string,
  cursor?: string,
  orderBy: "asc" | "desc" = "asc"
) => {
  const cleanStatus = status ? parseInt(status) : undefined;
  const cleanTake = Number(take || 1000);

  const query = async (take: number, type?: string | null, cursor?: string) =>
    await getCollectionClaimsByType({
      collectionId: id,
      includeType: type !== undefined,
      type: type ?? null,
      includeStatus: cleanStatus !== undefined,
      status: cleanStatus ?? null,
      orderBy: orderBy,
      take: take || 1000,
      cursor: cursor ?? null,
    });

  // claims with schemaType null still exist and a type filter was requested ->
  // schema types are still being loaded by the indexer's cellnode cron
  let claims = await query(1, null);
  if (claims.length && !!type) {
    return {
      data: [],
      metaData: {
        cursor: null,
        hasNextPage: false,
        schemaTypesLoaded: false,
        message:
          "Schema types for claims not loaded yet, please try again after 1 minute",
      },
    };
  }

  // plus 1 to check if there is a next page
  claims = await query(cleanTake + 1, type, cursor);

  if (claims.length == 0) {
    return {
      data: [],
      metaData: {
        cursor: null,
        hasNextPage: false,
        schemaTypesLoaded: true,
        message: "No claims found",
      },
    };
  }

  const hasNextPage = claims.length > cleanTake;
  if (hasNextPage) claims.pop();

  return {
    data: claims,
    metaData: {
      cursor: claims[claims.length - 1].claimId,
      hasNextPage: hasNextPage,
      schemaTypesLoaded: true,
      message: "Success",
    },
  };
};

// kept for parity checks / debugging
export { getCollectionClaimsTypeNull };
