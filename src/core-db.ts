import pg from "pg";
import { CORE_DATABASE_URL, CORE_DATABASE_USE_SSL, CORE_DB_POOL_MAX } from "./env.js";
import { logger } from "./logger.js";

// Small dedicated pool for the blocksync-core database (raw chain data),
// used only by the optional "core" pg service (the eventCores connection).
// Kept separate from the main pool so core-DB slowness can never starve
// regular GraphQL traffic. Null when CORE_DATABASE_URL is not configured —
// the core service is then not registered, so nothing can reach this pool.
export const corePool: pg.Pool | null = CORE_DATABASE_URL
  ? new pg.Pool({
      application_name: "Blocksync-api-core",
      connectionString: CORE_DATABASE_URL,
      max: CORE_DB_POOL_MAX,
      keepAlive: true,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      // Client-side cap (see db.ts for why not the server statement_timeout
      // pool option — pgbouncer rejects it as a startup parameter).
      query_timeout: 10_000,
      ...(CORE_DATABASE_USE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
    })
  : null;

// An errored idle client must never crash the process.
corePool?.on("error", (err) => {
  logger.error({ err: err.message }, "core pg pool error (idle client)");
});
