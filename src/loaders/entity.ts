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

const getIidsByIdsSql = `
SELECT i."id", i."context", i."controller", i."verificationMethod",
       i."authentication", i."assertionMethod", i."keyAgreement",
       i."capabilityInvocation", i."capabilityDelegation",
       i."linkedClaim", i."accordedRight", i."linkedEntity", i."alsoKnownAs"
FROM "IID" i
WHERE i."id" = ANY($1::text[]);
`;

// Serves the 12 passthrough DID fields returned verbatim from each entity's
// own IID row (no inheritance).
export const loadIidPassthrough = async (
  ids: ReadonlyArray<any>
): Promise<(IidPassthrough | null)[]> => {
  if (!ids.length) return [];
  const res = await pool.query(getIidsByIdsSql, [ids as string[]]);
  const byId = new Map<string, IidPassthrough>(
    res.rows.map((r: IidPassthrough) => [r.id, r])
  );
  return ids.map((id) => byId.get(id) ?? null);
};

type EntityChainRow = {
  rootId: string;
  depth: number;
  service: any[];
  linkedResource: any[];
};

// For each requested entity id, walk its `class` inheritance chain entirely in
// the database (one recursive query for the whole batch); rows ordered by depth
// ascending so the caller merges child-first. Depth capped to prevent cycles.
const getEntityInheritanceChainsSql = `
WITH RECURSIVE chain AS (
  SELECT i."id" AS root_id, 0 AS depth,
         i."context", i."service", i."linkedResource"
  FROM "IID" i
  WHERE i."id" = ANY($1::text[])
  UNION ALL
  SELECT c.root_id, c.depth + 1,
         parent."context", parent."service", parent."linkedResource"
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
SELECT root_id AS "rootId", depth, "service", "linkedResource"
FROM chain
ORDER BY root_id, depth;
`;

export type ResolvedEntity = {
  service: any[];
  linkedResource: any[];
  settings: Record<string, any>;
};

// Serves the 3 inheritance-resolved fields: service, linkedResource, settings.
// Merges service + linkedResource child-first (entity's own entries win),
// splits Settings resources out of linkedResource, and applies the IPFS
// endpoint mapping - identical to ixo-blocksync's loadResolvedEntities.
export const loadResolvedEntities = async (
  ids: ReadonlyArray<any>
): Promise<ResolvedEntity[]> => {
  if (!ids.length) return [];
  const res = await pool.query(getEntityInheritanceChainsSql, [
    ids as string[],
  ]);
  const rows: EntityChainRow[] = res.rows;

  const byRoot = new Map<string, EntityChainRow[]>();
  for (const row of rows) {
    const list = byRoot.get(row.rootId);
    if (list) list.push(row);
    else byRoot.set(row.rootId, [row]);
  }

  return ids.map((id) => {
    const chain = byRoot.get(id);
    if (!chain) return { service: [], linkedResource: [], settings: {} };

    const service: any[] = [];
    const serviceIds = new Set<string>();
    const linkedResource: any[] = [];
    const linkedResourceIds = new Set<string>();
    for (const node of chain) {
      for (const s of node.service ?? []) {
        if (!serviceIds.has(s.id)) {
          serviceIds.add(s.id);
          service.push(s);
        }
      }
      for (const r of node.linkedResource ?? []) {
        if (!linkedResourceIds.has(r.id)) {
          linkedResourceIds.add(r.id);
          linkedResource.push(r);
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
