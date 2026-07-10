import pg from "pg";
import { DATABASE_URL, DATABASE_USE_SSL, DB_POOL_MAX } from "./env.js";

// Single shared pool: PostGraphile (via makePgService) and the custom loaders
// all draw from here, so total connections per instance are capped by
// DB_POOL_MAX. The API is read-only; writes belong to ixo-blocksync (indexer).
export const pool = new pg.Pool({
  application_name: "Blocksync-api",
  connectionString: DATABASE_URL,
  max: DB_POOL_MAX,
  min: 2,
  keepAlive: true,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
  // Generous backstop only: GraphQL SQL is capped per-transaction via
  // pgSettings (STATEMENT_TIMEOUT_MS). query_timeout is enforced CLIENT-side
  // by node-postgres - deliberately NOT the server `statement_timeout` pool
  // option, which node-pg sends as a startup packet parameter that pgbouncer
  // rejects ("unsupported startup parameter"); production connects through
  // pgbouncer. Must stay high enough for PostGraphile's schema introspection
  // at boot on a busy database.
  query_timeout: 30_000,
  ...(DATABASE_USE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
});

// An errored idle client must never crash the process (Cloudflare-tunnel /
// LB idle drops surface here).
pool.on("error", (err) => {
  console.error("pg pool error (idle client):", err.message);
});
