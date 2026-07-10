// PostGraphile v5 marks json/jsonb codecs as having no "natural equality" or
// ordering (@dataplan/pg codecs.ts) and array attributes as unorderable, which
// makes PgAttributesPlugin infer `-attribute:filterBy` / `-attribute:orderBy`
// for them - so connection-filter silently drops the v4 `JSONFilter` fields
// (equalTo/contains/containsKey/...) and the orderBy enums for array/jsonb
// columns disappear from the schema.
//
// The ixo blocksync schema only uses `jsonb` (never plain `json`), which DOES
// support equality/containment/ordering operators in Postgres, and the v4 API
// exposed all of this - clients rely on it (e.g.
// `iidById: { linkedEntity: { contains: ... } }`). Restore v4 behaviour here.
export const JsonbFilterBehaviorPlugin: GraphileConfig.Plugin = {
  name: "JsonbFilterBehaviorPlugin",
  version: "1.0.0",
  description:
    "Re-enables filterBy/orderBy for jsonb and array columns to keep v4 schema compatibility",
  schema: {
    entityBehavior: {
      // v4's disableAggregatesByDefault also suppressed the relation-derived
      // aggregate orderBy enums (TOKEN_XS_BY_Y_SUM_..._ASC) except for tables
      // opted in via @aggregates. The OrderByAggregates plugin gates these on
      // the foreign table's "resource:relatedAggregates:orderBy" behavior; a
      // global defaultBehavior minus can't be re-enabled per table, so apply
      // the minus per-resource here, skipping @aggregates-tagged tables.
      // OrderByAggregates adds TOKEN_XS_BY_Y_SUM_... values to a table's
      // OrderBy enum for EVERY incoming relation by default. v4 only did so
      // when the aggregated (remote) table was opted in via @aggregates, so
      // disable the relation-level behavior when the remote table isn't
      // tagged.
      pgCodecRelation: {
        inferred(behavior, relation: any) {
          const remoteTags =
            relation.remoteResource?.codec?.extensions?.tags ??
            relation.remoteResource?.extensions?.tags;
          if (remoteTags?.aggregates === "on") return behavior;
          return [behavior, "-manyRelation:aggregates:orderBy" as any];
        },
      },
      pgCodecAttribute: {
        // "override" phase runs after "inferred", so this beats the inferred
        // negative behaviors from hasNaturalEquality/hasNaturalOrdering=false.
        // ("+attribute:x" is a valid runtime behavior string; the branded
        // BehaviorString type just doesn't enumerate +-prefixed variants.)
        override(behavior, [codec, attributeName]) {
          const attr = codec.attributes?.[attributeName];
          let c = attr?.codec;
          const extra: string[] = [];
          if (c?.arrayOfCodec) {
            // v4 exposed orderBy enums for array columns
            extra.push("+attribute:orderBy");
            c = c.arrayOfCodec;
          }
          // unwrap domains
          while (c?.domainOfCodec) c = c.domainOfCodec;
          if (c && c.name === "jsonb") {
            extra.push("+attribute:filterBy", "+attribute:orderBy");
          }
          return extra.length ? ([behavior, ...extra] as any) : behavior;
        },
      },
    },
  },
};
