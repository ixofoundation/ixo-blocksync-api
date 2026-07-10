import { extendSchema, gql } from "postgraphile/utils";
import { loadOne } from "postgraphile/grafast";
import { batchClaimSchemaTypesLoaded } from "../loaders/claims.js";

// v5 port of ixo-blocksync src/graphql/claims.ts.
export const ClaimsPlugin = extendSchema(() => ({
  typeDefs: gql`
    extend type ClaimCollection {
      """
      Checks if there are any claims with null schemaType
      """
      claimSchemaTypesLoaded: Boolean!
    }
  `,
  objects: {
    ClaimCollection: {
      plans: {
        claimSchemaTypesLoaded($collection: any) {
          return loadOne($collection.get("id"), batchClaimSchemaTypesLoaded);
        },
      },
    },
  },
}));
