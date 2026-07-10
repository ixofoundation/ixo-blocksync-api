import { jsonPgSmartTags } from "postgraphile/utils";
import { RELATION_COMPAT_CONSTRAINT_TAGS } from "./relation-compat-tags.js";

// Identical to ixo-blocksync src/graphql/smart_tags_plugin.ts - keeps the
// generated GraphQL relation/field names byte-compatible with the v4 API.
// RELATION_COMPAT_CONSTRAINT_TAGS additionally pins every FK relation whose
// v5-simplified name would differ from the deployed v4 name.
export const SmartTagsPlugin = jsonPgSmartTags({
  version: 1,
  config: {
    class: {
      // aggregates:"on" is translated by pg-aggregates to
      // +aggregates +aggregates:filterBy +aggregates:orderBy; the extra
      // +relatedAggregates:orderBy re-enables the foreign-table gate of the
      // OrderByAggregates plugin (disabled globally in preset.ts) so the
      // TOKEN_*_BY_*_SUM_... enums exist on related orderBys like in v4.
      "public.TokenTransaction": {
        tags: {
          aggregates: "on",
          behavior: "+relatedAggregates:orderBy",
        },
      },
      "public.TokenRetired": {
        tags: {
          aggregates: "on",
          behavior: "+relatedAggregates:orderBy",
        },
      },
      "public.TokenCancelled": {
        tags: {
          aggregates: "on",
          behavior: "+relatedAggregates:orderBy",
        },
      },
    },
    constraint: {
      // Message -> Transaction FK points at Transaction.id (surrogate PK) but
      // keeps the pre-surrogate GraphQL relation names.
      "public.Message.Message_transactionHash_fkey": {
        tags: {
          fieldName: "transactionByTransactionHash",
          foreignFieldName: "messagesByTransactionHash",
        },
      },
      // v7 turned Evaluation into 1:N (history); the forward FK
      // currentEvaluationId keeps the pre-v7 singular field name.
      "public.Claim.Claim_currentEvaluationId_fkey": {
        tags: {
          fieldName: "evaluation",
        },
      },
      // DisputeResolution is 1:1 with Dispute; expose it as
      // Dispute.resolution.
      "public.DisputeResolution.DisputeResolution_disputeId_fkey": {
        tags: {
          fieldName: "dispute",
          foreignFieldName: "resolution",
        },
      },
      // NameRecord.namespace (column) collides with the simplified relation
      // name for NameRecord_namespace_fkey. The v4 simplify inflector fell
      // back to the ByNamespace names automatically; v5 errors on the
      // conflict instead, so pin the exact v4 field names here.
      "public.NameRecord.NameRecord_namespace_fkey": {
        tags: {
          fieldName: "namespaceByNamespace",
          foreignFieldName: "nameRecordsByNamespace",
        },
      },
      ...RELATION_COMPAT_CONSTRAINT_TAGS,
    },
  },
});
