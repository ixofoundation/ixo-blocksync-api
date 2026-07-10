import { pool } from "../db.js";
import { IPFS_SERVICE_MAPPING } from "../env.js";

// ---------------------------------------------------------------------------
// Ported 1:1 from ixo-blocksync src/postgres/entity.ts + src/handlers/entity_handler.ts
// (read paths only). These are grafast `loadOne` batch callbacks: they receive
// the full set of entity ids referenced in a request and resolve them in one
// database round-trip each.
// ---------------------------------------------------------------------------

export type IidPassthrough = {
  id: string;
  context: any;
  controller: string[] | null;
  verificationMethod: any;
  authentication: string[] | null;
  assertionMethod: string[] | null;
  keyAgreement: string[] | null;
  capabilityInvocation: string[] | null;
  capabilityDelegation: string[] | null;
  linkedClaim: any;
  accordedRight: any;
  linkedEntity: any;
  alsoKnownAs: string;
};

// Every column the passthrough fields may read; doubles as the whitelist
// guarding the dynamic SELECT below.
const PASSTHROUGH_COLUMNS = [
  "context",
  "controller",
  "verificationMethod",
  "authentication",
  "assertionMethod",
  "keyAgreement",
  "capabilityInvocation",
  "capabilityDelegation",
  "linkedClaim",
  "accordedRight",
  "linkedEntity",
  "alsoKnownAs",
] as const;
const PASSTHROUGH_COLUMN_SET: ReadonlySet<string> = new Set(
  PASSTHROUGH_COLUMNS
);

const iidSqlForColumns = new Map<string, string>();
const getIidsByIdsSql = (columns: string[]): string => {
  const key = columns.join(",");
  let sql = iidSqlForColumns.get(key);
  if (!sql) {
    sql = `
SELECT i."id"${columns.map((c) => `, i."${c}"`).join("")}
FROM "IID" i
WHERE i."id" = ANY($1::text[]);
`;
    iidSqlForColumns.set(key, sql);
  }
  return sql;
};

// Serves the 12 passthrough DID fields returned verbatim from each entity's
// own IID row (no inheritance). grafast reports which fields the operation
// actually accessed (info.attributes, populated via $load.get(field)), so we
// only SELECT those columns - a query reading just `controller` no longer
// drags the fat jsonb documents (verificationMethod, linkedEntity, ...) off
// disk for every entity.
export const loadIidPassthrough = async (
  ids: ReadonlyArray<any>,
  info?: { attributes?: ReadonlyArray<string | number> }
  // Record<string, any> (not IidPassthrough) so grafast's .get() generics accept it
): Promise<(Record<string, any> | null)[]> => {
  if (!ids.length) return [];
  const requested = [
    ...new Set(
      (info?.attributes ?? [])
        .map(String)
        .filter((a) => PASSTHROUGH_COLUMN_SET.has(a))
    ),
  ].sort();
  const columns = requested.length ? requested : [...PASSTHROUGH_COLUMNS];
  const res = await pool.query(getIidsByIdsSql(columns), [ids as string[]]);
  const byId = new Map<string, Record<string, any>>(
    res.rows.map((r: IidPassthrough) => [r.id, r])
  );
  return ids.map((id) => byId.get(id) ?? null);
};

// Phase 1: walk each requested entity's `class` inheritance chain entirely in
// the database, returning only (rootId, depth, nodeId) tuples - NO payloads.
// context is carried internally to find the next parent but never returned.
// Depth capped to prevent cycles.
const getEntityInheritanceChainIdsSql = `
WITH RECURSIVE chain AS (
  SELECT i."id" AS root_id, 0 AS depth, i."id" AS node_id, i."context"
  FROM "IID" i
  WHERE i."id" = ANY($1::text[])
  UNION ALL
  SELECT c.root_id, c.depth + 1, parent."id", parent."context"
  FROM chain c
  JOIN "IID" parent ON parent."id" = (
    SELECT elem->>'val'
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(c."context") = 'array' THEN c."context" ELSE '[]'::jsonb END
    ) elem
    WHERE elem->>'key' = 'class'
    LIMIT 1
  )
  WHERE c.depth < 20
)
SELECT root_id AS "rootId", depth, node_id AS "nodeId"
FROM chain
ORDER BY root_id, depth;
`;

// Phase 2: fetch each DISTINCT chain node's payload exactly once. In a batch
// of same-class entities (the common case: collection listings), the shared
// class's service/linkedResource used to be returned once PER CHILD by the
// old single-query CTE; now it crosses the wire once per batch. Column list
// is pruned to what the operation accessed (settings derives from
// linkedResource).
const getIidPayloadsSql = (withService: boolean, withLinked: boolean) => `
SELECT i."id"${withService ? ', i."service"' : ""}${
  withLinked ? ', i."linkedResource"' : ""
}
FROM "IID" i
WHERE i."id" = ANY($1::text[]);
`;

export type ResolvedEntity = {
  service: any[];
  linkedResource: any[];
  settings: Record<string, any>;
};

// Serves the 3 inheritance-resolved fields: service, linkedResource, settings.
// Merges service + linkedResource child-first (entity's own entries win),
// splits Settings resources out of linkedResource, and applies the IPFS
// endpoint mapping - identical results to ixo-blocksync's
// loadResolvedEntities, computed from deduplicated ancestor payloads.
export const loadResolvedEntities = async (
  ids: ReadonlyArray<any>,
  info?: { attributes?: ReadonlyArray<string | number> }
  // Record<string, any> (not ResolvedEntity) so grafast's .get() generics accept it
): Promise<Record<string, any>[]> => {
  if (!ids.length) return [];

  const attrs = new Set((info?.attributes ?? []).map(String));
  // no/unknown attribute info -> fetch everything (safe fallback)
  const wantService = attrs.size === 0 || attrs.has("service");
  const wantLinked =
    attrs.size === 0 || attrs.has("linkedResource") || attrs.has("settings");

  const chainRes = await pool.query(getEntityInheritanceChainIdsSql, [
    ids as string[],
  ]);
  const chainRows: { rootId: string; depth: number; nodeId: string }[] =
    chainRes.rows;

  const byRoot = new Map<string, string[]>();
  const distinctNodes = new Set<string>();
  for (const row of chainRows) {
    // rows arrive ordered by (rootId, depth) - keep child-first order
    const list = byRoot.get(row.rootId);
    if (list) list.push(row.nodeId);
    else byRoot.set(row.rootId, [row.nodeId]);
    distinctNodes.add(row.nodeId);
  }

  const payloadRes = distinctNodes.size
    ? await pool.query(getIidPayloadsSql(wantService, wantLinked), [
        [...distinctNodes],
      ])
    : { rows: [] as any[] };
  const payloadById = new Map<string, { service?: any[]; linkedResource?: any[] }>(
    payloadRes.rows.map((r: any) => [r.id, r])
  );

  return ids.map((id) => {
    const chain = byRoot.get(id);
    if (!chain) return { service: [], linkedResource: [], settings: {} };

    const service: any[] = [];
    const serviceIds = new Set<string>();
    const linkedResource: any[] = [];
    const linkedResourceIds = new Set<string>();
    for (const nodeId of chain) {
      const node = payloadById.get(nodeId);
      if (!node) continue;
      if (wantService) {
        for (const s of node.service ?? []) {
          if (!serviceIds.has(s.id)) {
            serviceIds.add(s.id);
            service.push(s);
          }
        }
      }
      if (wantLinked) {
        for (const r of node.linkedResource ?? []) {
          if (!linkedResourceIds.has(r.id)) {
            linkedResourceIds.add(r.id);
            linkedResource.push(r);
          }
        }
      }
    }

    const settings: Record<string, any> = {};
    const nonSettingsResources: any[] = [];
    for (const resource of linkedResource) {
      if (resource.type === "Settings") {
        if (!settings[resource.description]) {
          settings[resource.description] = resource;
        }
      } else {
        nonSettingsResources.push(resource);
      }
    }

    const finalService = IPFS_SERVICE_MAPPING
      ? service.map((s) =>
          s.id?.includes("ipfs")
            ? { ...s, serviceEndpoint: IPFS_SERVICE_MAPPING }
            : s
        )
      : service;

    return {
      service: finalService,
      linkedResource: nonSettingsResources,
      settings,
    };
  });
};

const getEntityDeviceAndNoExternalIdSql = `
SELECT e."id"
FROM "Entity" AS e
WHERE e."externalId" IS NULL AND e."type" = 'asset/device'
LIMIT 1;
`;

// Query.deviceExternalIdsLoaded - true when no device entity is missing its
// externalId. loadOne batch callback with a constant key.
export const batchDeviceExternalIdsLoaded = async (
  keys: readonly unknown[]
): Promise<boolean[]> => {
  const res = await pool.query(getEntityDeviceAndNoExternalIdSql);
  const loaded = res.rows.length === 0;
  return keys.map(() => loaded);
};

// --- reads used by the token total queries (ported from postgres/entity.ts) ---

const getEntityDeviceAccountsSql = `
SELECT e."id", e."accounts"
FROM "Entity" e
WHERE e."owner" = $1 AND e."type" = 'asset/device';
`;
export const getEntityDeviceAccounts = async (
  owner: string
): Promise<{ id: string; accounts: any }[]> => {
  const res = await pool.query(getEntityDeviceAccountsSql, [owner]);
  return res.rows;
};

const getEntityAccountsByIidContextSql = `
SELECT e."id", e."accounts"
FROM "Entity" e
INNER JOIN "IID" i ON e."id" = i."id"
WHERE i."context" @> $1;
`;
export const getEntityAccountsByIidContext = async (
  context: string
): Promise<{ id: string; accounts: any }[]> => {
  const res = await pool.query(getEntityAccountsByIidContextSql, [context]);
  return res.rows;
};
