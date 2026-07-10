import { extendSchema, gql } from "postgraphile/utils";
import { loadOne, access, constant } from "postgraphile/grafast";
import {
  loadIidPassthrough,
  loadResolvedEntities,
  batchDeviceExternalIdsLoaded,
} from "../loaders/entity.js";

// The 12 DID fields returned verbatim from the entity's own IID row.
const PASSTHROUGH_FIELDS = [
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

// The 3 fields resolved with class-inheritance merging.
const RESOLVED_FIELDS = ["service", "linkedResource", "settings"] as const;

// v5 port of ixo-blocksync src/graphql/entity.ts. Every field plan keys off
// the row's primary key; grafast dedupes the loadOne steps (same key step +
// same callback), so all 12 passthrough fields cost ONE batched query per
// request and the 3 resolved fields ONE more - the same round-trip profile as
// the v4 DataLoaders.
export const EntityPlugin = extendSchema(() => {
  const entityPlans: Record<string, any> = {};
  for (const field of PASSTHROUGH_FIELDS) {
    entityPlans[field] = ($entity: any) =>
      access(loadOne($entity.get("id"), loadIidPassthrough), field);
  }
  for (const field of RESOLVED_FIELDS) {
    entityPlans[field] = ($entity: any) =>
      access(loadOne($entity.get("id"), loadResolvedEntities), field);
  }

  return {
    typeDefs: gql`
      extend type Query {
        deviceExternalIdsLoaded: Boolean!
      }

      extend type Entity {
        context: JSON!
        controller: [String!]!
        verificationMethod: JSON!
        service: JSON!
        authentication: [String!]!
        assertionMethod: [String!]!
        keyAgreement: [String!]!
        capabilityInvocation: [String!]!
        capabilityDelegation: [String!]!
        linkedResource: JSON!
        linkedClaim: JSON!
        accordedRight: JSON!
        linkedEntity: JSON!
        alsoKnownAs: String!
        settings: JSON!
      }
    `,
    objects: {
      Query: {
        plans: {
          deviceExternalIdsLoaded() {
            return loadOne(constant("all"), batchDeviceExternalIdsLoaded);
          },
        },
      },
      Entity: {
        plans: entityPlans,
      },
    },
  };
});
