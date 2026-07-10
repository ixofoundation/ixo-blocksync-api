import { extendSchema, gql } from "postgraphile/utils";
import { loadOne, constant } from "postgraphile/grafast";
import * as Tokenomics from "../loaders/tokenomics.js";

// v5 port of ixo-blocksync src/graphql/tokenomics.ts. These hit the chain RPC
// (not the DB); loadOne with a constant key is just the plan-world wrapper for
// a one-shot async call.
const chainCall =
  (fn: () => Promise<any>) => (keys: ReadonlyArray<unknown>) =>
    fn().then((result) => keys.map(() => result));

const batchSupplyTotal = chainCall(Tokenomics.supplyTotal);
const batchSupplyCommunityPool = chainCall(Tokenomics.supplyCommunityPool);
const batchInflation = chainCall(Tokenomics.inflation);
const batchSupplyStaked = chainCall(Tokenomics.supplyStaked);
const batchSupplyIBC = chainCall(Tokenomics.supplyIBC);

export const TokenomicsPlugin = extendSchema(() => ({
  typeDefs: gql`
    extend type Query {
      tokenomicsSupplyTotal: JSON!
      tokenomicsSupplyCommunityPool: JSON!
      tokenomicsInflation: JSON!
      tokenomicsSupplyStaked: JSON!
      tokenomicsSupplyIBC: JSON!
    }
  `,
  objects: {
    Query: {
      plans: {
        tokenomicsSupplyTotal: () => loadOne(constant("t"), batchSupplyTotal),
        tokenomicsSupplyCommunityPool: () =>
          loadOne(constant("c"), batchSupplyCommunityPool),
        tokenomicsInflation: () => loadOne(constant("i"), batchInflation),
        tokenomicsSupplyStaked: () =>
          loadOne(constant("s"), batchSupplyStaked),
        tokenomicsSupplyIBC: () => loadOne(constant("b"), batchSupplyIBC),
      },
    },
  },
}));
