import 'dotenv/config';

const num = (v: string | undefined, fallback: number): number => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const NODE_ENV = process.env.NODE_ENV || 'development';
export const isProd = NODE_ENV === 'production';

export const PORT = num(process.env.PORT, 8081);

export const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

export const DATABASE_USE_SSL = Number(process.env.DATABASE_USE_SSL ?? '0') || 0;
export const DATABASE_SCHEMA = process.env.DATABASE_SCHEMA || 'public';
export const DB_POOL_MAX = num(process.env.DB_POOL_MAX, 20);
export const STATEMENT_TIMEOUT_MS = num(process.env.STATEMENT_TIMEOUT_MS, 8000);

export const RATE_LIMIT_WINDOW_MS = num(process.env.RATE_LIMIT_WINDOW_MS, 1000);
export const RATE_LIMIT_MAX = num(process.env.RATE_LIMIT_MAX, 200);

// --- request analytics logging ---
export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
// requests at least this slow are logged at warn so they stand out
export const LOG_SLOW_MS = num(process.env.LOG_SLOW_MS, 1000);

// express `trust proxy`: numeric hop count or string spec
const trustProxyRaw = process.env.TRUST_PROXY ?? '1';
export const TRUST_PROXY: number | string = Number.isFinite(Number(trustProxyRaw)) ? Number(trustProxyRaw) : trustProxyRaw;

export const IPFS_SERVICE_MAPPING = process.env.IPFS_SERVICE_MAPPING || '';
export const IPFS_GATEWAY = process.env.IPFS_GATEWAY || 'https://ipfs.gateway.ixo.world';

// Chain RPC endpoint; only the tokenomics* GraphQL fields need it
export const RPC = process.env.RPC || '';

// Empty string disables SDL export
export const EXPORT_SCHEMA_PATH = process.env.EXPORT_SCHEMA_PATH ?? 'public/graphql/schema.graphql';

// --- block-aware response cache ---
// Invalidated whenever the indexer commits a block (pg_notify trigger on
// "Chain" + poll backstop), so it can never serve data staler than the DB.
// Set BLOCK_CACHE=0 to disable.
export const BLOCK_CACHE = (process.env.BLOCK_CACHE ?? '1') !== '0';
// LISTEN/NOTIFY does not work through pgbouncer transaction pooling - point
// this at the DIRECT postgres service (e.g. ixo-postgres-ha) for instant
// invalidation. Falls back to DATABASE_URL; if LISTEN can't be established
// the poll backstop below still bounds staleness to BLOCK_CACHE_BACKSTOP_MS.
export const BLOCK_CACHE_LISTEN_DATABASE_URL = process.env.BLOCK_CACHE_LISTEN_DATABASE_URL || process.env.DATABASE_URL;
export const BLOCK_CACHE_CHANNEL = process.env.BLOCK_CACHE_CHANNEL || 'blocksync_new_block';
export const BLOCK_CACHE_MAX_ENTRIES = num(process.env.BLOCK_CACHE_MAX_ENTRIES, 500);
export const BLOCK_CACHE_MAX_ENTRY_BYTES = num(process.env.BLOCK_CACHE_MAX_ENTRY_BYTES, 2 * 1024 * 1024);
export const BLOCK_CACHE_BACKSTOP_MS = num(process.env.BLOCK_CACHE_BACKSTOP_MS, 3000);
