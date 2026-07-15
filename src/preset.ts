import { PostGraphileAmberPreset } from "postgraphile/presets/amber";
import { makeV4Preset } from "postgraphile/presets/v4";
import { makePgService } from "postgraphile/adaptors/pg";
import { PgSimplifyInflectionPreset } from "@graphile/simplify-inflection";
import { PostGraphileConnectionFilterPreset } from "postgraphile-plugin-connection-filter";
import { PgAggregatesPreset } from "@graphile/pg-aggregates";
import { pool } from "./db.js";
import {
  DATABASE_SCHEMA,
  EXPORT_SCHEMA_PATH,
  PORT,
  STATEMENT_TIMEOUT_MS,
  isProd,
} from "./env.js";
import { SmartTagsPlugin } from "./plugins/smart-tags.js";
import { JsonbFilterBehaviorPlugin } from "./plugins/jsonb-filter-behavior.js";
import { V4DatetimeFormatPlugin } from "./plugins/v4-datetime-format.js";
import { EntityPlugin } from "./plugins/entity.js";
import { TokenPlugin } from "./plugins/token.js";
import { ClaimsPlugin } from "./plugins/claims.js";
import { TokenomicsPlugin } from "./plugins/tokenomics.js";
import { CoreEventsOnlyPlugin } from "./plugins/core-events-only.js";
import { corePool } from "./core-db.js";

// Mirrors ixo-blocksync's PostGraphile v4 options through the official V4
// compatibility preset so the generated schema keeps the v4 shape existing
// clients depend on.
export const preset: GraphileConfig.Preset = {
  extends: [
    PostGraphileAmberPreset,
    makeV4Preset({
      dynamicJson: true,
      setofFunctionsContainNulls: false,
      ignoreRBAC: false,
      disableDefaultMutations: true,
      graphiql: true,
      retryOnInitFail: true,
      ...(isProd
        ? {
            extendedErrors: ["errcode"],
            disableQueryLog: true,
            allowExplain: false,
          }
        : {
            showErrorStack: "json",
            extendedErrors: ["hint", "detail", "errcode"],
            allowExplain: true,
          }),
    }),
    PgSimplifyInflectionPreset,
    PostGraphileConnectionFilterPreset,
    PgAggregatesPreset,
  ],
  plugins: [
    SmartTagsPlugin,
    JsonbFilterBehaviorPlugin,
    V4DatetimeFormatPlugin,
    EntityPlugin,
    TokenPlugin,
    ClaimsPlugin,
    TokenomicsPlugin,
    // No-op unless the "core" service below is configured.
    CoreEventsOnlyPlugin,
  ],
  pgServices: [
    makePgService({
      pool,
      schemas: [DATABASE_SCHEMA],
    }),
    // Optional second service: the blocksync-core database, scoped to the
    // EventCore table only (CoreEventsOnlyPlugin) and exposed as the plain
    // `eventCores` connection. Consumers (e.g. ixo-domain-indexer) poll it
    // with filter/orderBy for per-block chain events; omitted entirely when
    // CORE_DATABASE_URL is not set, so they get a clear "Cannot query field".
    ...(corePool
      ? [
          makePgService({
            name: "core",
            pool: corePool,
            schemas: ["public"],
          }),
        ]
      : []),
  ],
  grafserv: {
    port: PORT,
    graphqlPath: "/graphql",
    graphiql: true,
    graphiqlPath: "/graphiql",
    websockets: false,
    // v4 bodySizeLimit "500kB" -> bytes
    maxRequestLength: 500_000,
  },
  grafast: {
    context: () => ({
      // Same per-request statement timeout the v4 API applies via pgSettings.
      pgSettings: {
        statement_timeout: String(STATEMENT_TIMEOUT_MS),
      },
    }),
  },
  schema: {
    // ConnectionFilterPlugin options (same values as ixo-blocksync)
    connectionFilterRelations: true,
    connectionFilterAllowNullInput: true,
    connectionFilterAllowEmptyObjectInput: true,
    // pg-aggregates: aggregates are opt-in per table via the @aggregates
    // smart tag (see plugins/smart-tags.ts) - the tag translation re-adds
    // +aggregates +aggregates:filterBy per table, and our tags additionally
    // re-add +relatedAggregates:orderBy. The three scopes below are the
    // foreign-table gates of AddConnectionAggregates/FilterRelational/
    // OrderByAggregates, so disabling them globally reproduces v4's
    // disableAggregatesByDefault exactly. (A blanket "-aggregates:orderBy"
    // would also block the relation-scope check that tags can't re-enable.)
    // (relatedAggregates:orderBy is handled per-resource in
    // JsonbFilterBehaviorPlugin because a global minus here cannot be
    // re-enabled by the per-table smart tags.)
    defaultBehavior: "-aggregates -aggregates:filterBy",
    ...(EXPORT_SCHEMA_PATH
      ? { exportSchemaSDLPath: EXPORT_SCHEMA_PATH }
      : {}),
  },
};
