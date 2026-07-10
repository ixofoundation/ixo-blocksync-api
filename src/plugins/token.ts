import { extendSchema, gql } from "postgraphile/utils";
import { loadOne, list } from "postgraphile/grafast";
import {
  batchGetAccountTokens,
  batchGetTokensTotalByAddress,
  batchGetTokensTotalForEntities,
  batchGetTokensTotalForCollection,
  batchGetTokensTotalForCollectionAmounts,
} from "../loaders/token.js";

// v5 port of ixo-blocksync src/graphql/token.ts. Each root field becomes a
// loadOne over the (address|did, name, allEntityRetired) tuple; fields
// requested together in one operation batch into a shared balances lookup.
const tokenFieldPlan =
  (batchFn: (specs: ReadonlyArray<any>) => Promise<any[]>, keyArg: string) =>
  (_: any, fieldArgs: any) => {
    const $spec = list([
      fieldArgs.getRaw(keyArg),
      fieldArgs.getRaw("name"),
      fieldArgs.getRaw("allEntityRetired"),
    ]);
    return loadOne($spec as any, batchFn);
  };

export const TokenPlugin = extendSchema(() => ({
  typeDefs: gql`
    extend type Query {
      getAccountTokens(
        address: String!
        name: String
        allEntityRetired: Boolean
      ): JSON!
      getTokensTotalByAddress(
        address: String!
        name: String
        allEntityRetired: Boolean
      ): JSON!
      getTokensTotalForEntities(
        address: String!
        name: String
        allEntityRetired: Boolean
      ): JSON!
      getTokensTotalForCollection(
        did: String!
        name: String
        allEntityRetired: Boolean
      ): JSON!
      getTokensTotalForCollectionAmounts(
        did: String!
        name: String
        allEntityRetired: Boolean
      ): JSON!
    }
  `,
  objects: {
    Query: {
      plans: {
        getAccountTokens: tokenFieldPlan(batchGetAccountTokens, "address"),
        getTokensTotalByAddress: tokenFieldPlan(
          batchGetTokensTotalByAddress,
          "address"
        ),
        getTokensTotalForEntities: tokenFieldPlan(
          batchGetTokensTotalForEntities,
          "address"
        ),
        getTokensTotalForCollection: tokenFieldPlan(
          batchGetTokensTotalForCollection,
          "did"
        ),
        getTokensTotalForCollectionAmounts: tokenFieldPlan(
          batchGetTokensTotalForCollectionAmounts,
          "did"
        ),
      },
    },
  },
}));
