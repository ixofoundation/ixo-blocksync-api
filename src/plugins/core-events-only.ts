// Scopes the optional "core" pg service (the blocksync-core database, see
// preset.ts) to exactly the EventCore table, which is then served as a
// completely standard PostGraphile connection (eventCores) with the usual
// filter / orderBy / pagination — no custom SQL or resolvers.
//
// Everything else in that database (BlockCore, TransactionCore, MessageCore,
// node-pg-migrate's pgmigrations, ...) is behavior-disabled so it neither
// bloats the public schema nor collides with identically-named tables from
// the main service (pgmigrations exists in both databases).

const isHiddenCoreEntity = (entity: {
  extensions?: { pg?: { serviceName?: string | null; name?: string | null } | undefined };
}): boolean =>
  entity.extensions?.pg?.serviceName === "core" &&
  entity.extensions?.pg?.name !== "EventCore";

export const CoreEventsOnlyPlugin: GraphileConfig.Plugin = {
  name: "CoreEventsOnlyPlugin",
  version: "1.0.0",
  schema: {
    entityBehavior: {
      pgResource: {
        override(behavior, resource) {
          return isHiddenCoreEntity(resource) ? [behavior, "-*"] : behavior;
        },
      },
      pgCodec: {
        override(behavior, codec) {
          return isHiddenCoreEntity(codec) ? [behavior, "-*"] : behavior;
        },
      },
    },
  },
};
