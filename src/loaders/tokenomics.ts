import Long from "long";
import { createQueryClient } from "@ixo/impactxclient-sdk";
import { RPC } from "../env.js";

// ---------------------------------------------------------------------------
// Ported from ixo-blocksync src/handlers/tokenomics_handler.ts (query paths
// only - the accounts/balances *writer* stays in the indexer).
//
// These fields read the chain RPC, not the database. The query client is
// created lazily so the API boots fine without an RPC endpoint; the fields
// simply error if queried while RPC is unset.
// ---------------------------------------------------------------------------

type QueryClient = Awaited<ReturnType<typeof createQueryClient>>;

let clientPromise: Promise<QueryClient> | undefined;
const qc = (): Promise<QueryClient> => {
  if (!RPC) {
    throw new Error(
      "RPC endpoint not configured - tokenomics fields are unavailable"
    );
  }
  clientPromise ??= createQueryClient(RPC).catch((err) => {
    clientPromise = undefined; // allow retry on next request
    throw err;
  });
  return clientPromise;
};

const pagination = (key?: Uint8Array): any => ({
  key: key || new Uint8Array(),
  limit: Long.fromNumber(1000),
  offset: Long.fromNumber(0),
});

export const supplyTotal = async () => {
  const client = await qc();
  let supply: any[] = [];
  let key: Uint8Array | undefined;

  while (true) {
    const res = await client.cosmos.bank.v1beta1.totalSupply({
      pagination: pagination(key),
    });
    supply = [...supply, ...res.supply];
    key = (res.pagination as any)?.nextKey || undefined;
    if (!key?.length) break;
  }

  // convert all ibc denoms to traces to see the original denom
  for (const sup of supply) {
    if (sup.denom.includes("ibc/")) {
      const trace = await client.ibc.applications.transfer.v1.denomTrace({
        hash: sup.denom.split("/")[1],
      });
      sup.trace = trace.denomTrace;
    }
  }

  return supply;
};

const getIBCEscrows = async (includeBalance = false) => {
  const client = await qc();
  const channels = await client.ibc.core.channel.v1.channels({
    pagination: pagination(),
  });

  const escrows = await Promise.all(
    channels.channels.map(async (c: any) => {
      const escrowAcc =
        await client.ibc.applications.transfer.v1.escrowAddress({
          portId: c.portId,
          channelId: c.channelId,
        });
      const escrowBalance = includeBalance
        ? await client.cosmos.bank.v1beta1.balance({
            address: escrowAcc.escrowAddress,
            denom: "uixo",
          })
        : undefined;
      return {
        account: escrowAcc.escrowAddress,
        balance: escrowBalance?.balance?.amount ?? "0",
      };
    })
  );
  return escrows;
};

export const supplyIBC = async () => {
  const escrows = await getIBCEscrows(true);
  let total = 0;
  escrows.forEach((e) => {
    total += Number(e.balance);
  });
  return total;
};

export const supplyStaked = async () => {
  const client = await qc();
  const res = await client.cosmos.staking.v1beta1.pool({});
  return res.pool;
};

export const supplyCommunityPool = async () => {
  const client = await qc();
  const res = await client.cosmos.distribution.v1beta1.communityPool();
  return res.pool.map((c: any) => ({ ...c, amount: c.amount.slice(0, -18) }));
};

export const inflation = async () => {
  return 0.05;
};
