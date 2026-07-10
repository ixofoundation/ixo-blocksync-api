import "dotenv/config";

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const NODE_ENV = process.env.NODE_ENV || "development";
export const isProd = NODE_ENV === "production";

export const PORT = num(process.env.PORT, 8081);

export const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

export const DATABASE_USE_SSL =
  Number(process.env.DATABASE_USE_SSL ?? "0") || 0;
export const DATABASE_SCHEMA = process.env.DATABASE_SCHEMA || "public";
export const DB_POOL_MAX = num(process.env.DB_POOL_MAX, 15);
export const STATEMENT_TIMEOUT_MS = num(process.env.STATEMENT_TIMEOUT_MS, 4000);

export const RATE_LIMIT_WINDOW_MS = num(process.env.RATE_LIMIT_WINDOW_MS, 1000);
export const RATE_LIMIT_MAX = num(process.env.RATE_LIMIT_MAX, 200);

// express `trust proxy`: numeric hop count or string spec
const trustProxyRaw = process.env.TRUST_PROXY ?? "1";
export const TRUST_PROXY: number | string = Number.isFinite(
  Number(trustProxyRaw)
)
  ? Number(trustProxyRaw)
  : trustProxyRaw;

export const IPFS_SERVICE_MAPPING = process.env.IPFS_SERVICE_MAPPING || "";
export const IPFS_GATEWAY =
  process.env.IPFS_GATEWAY || "https://ipfs.gateway.ixo.world";

// Chain RPC endpoint; only the tokenomics* GraphQL fields need it
export const RPC = process.env.RPC || "";

// Empty string disables SDL export
export const EXPORT_SCHEMA_PATH =
  process.env.EXPORT_SCHEMA_PATH ?? "public/graphql/schema.graphql";
