import DataLoader from "dataloader";
import { pool } from "../db.js";
import {
  getEntityAccountsByIidContext,
  getEntityDeviceAccounts,
} from "./entity.js";

// ---------------------------------------------------------------------------
// Ported 1:1 from ixo-blocksync src/postgres/token.ts (read paths) +
// src/handlers/token_handler.ts + src/graphql/token.ts.
//
// The five token Query fields are exposed to grafast as loadOne batch
// callbacks (batchGetAccountTokens etc. below). Within one grafast batch we
// share a single DataLoader over per-(address, tokenId) balances, so entity /
// collection fan-outs still collapse into one `address = ANY(...)` query per
// distinct name filter - the same optimisation ixo-blocksync applies through
// its per-request DataLoader.
// ---------------------------------------------------------------------------

export type AccountTokenBalance = {
  tokenId: string;
  amount: bigint;
  minted: bigint;
  retired: bigint;
  name: string;
  collection: string;
  contractAddress: string;
  description: string;
  image: string;
};

// Single indexed read of an address's full holdings, joined to the token /
// token-class metadata the resolvers need.
const getAccountTokenBalancesSql = `
SELECT b."address", b."tokenId", b."amount", b."minted", b."retired",
       t."name", t."collection",
       tc."contractAddress", tc."description", tc."image"
FROM "TokenBalance" b
JOIN "Token" t       ON t."id"   = b."tokenId"
JOIN "TokenClass" tc ON tc."name" = t."name"
WHERE b."address" = ANY($1::text[])
  AND ($2::text IS NULL OR t."name" = $2);
`;

const getAccountTokenBalancesBatch = async (
  addresses: string[],
  name?: string | null
): Promise<(AccountTokenBalance & { address: string })[]> => {
  if (!addresses.length) return [];
  const res = await pool.query(getAccountTokenBalancesSql, [
    addresses,
    name ?? null,
  ]);
  return res.rows;
};

const getTokenRetiredAmountSql = `
SELECT "id", SUM("amount")::bigint AS "amount"
FROM "TokenRetired"
WHERE "id" = ANY($1::text[])
GROUP BY "id";
`;
const getTokenRetiredAmountSUM = async (
  ids: string[]
): Promise<{ id: string; amount: bigint }[]> => {
  if (!ids.length) return [];
  const res = await pool.query(getTokenRetiredAmountSql, [ids]);
  return res.rows;
};

// --- per-batch balances DataLoader (mirrors createGetAccountTransactionsLoader) ---

type BalancesLoader = DataLoader<string, AccountTokenBalance[]>;

const balancesKey = (address: string, name?: string | null): string =>
  `${address}-${name || "NULL"}`;

// Addresses never contain "-", so split on the first one. All keys requested
// in the same tick collapse into one DB query per distinct name filter.
const createBalancesLoader = (): BalancesLoader =>
  new DataLoader<string, AccountTokenBalance[]>(
    async (keys: readonly string[]) => {
      const byName = new Map<string | null, Set<string>>();
      for (const key of keys) {
        const sep = key.indexOf("-");
        const address = key.slice(0, sep);
        const rawName = key.slice(sep + 1);
        const name = rawName === "NULL" ? null : rawName;
        if (!byName.has(name)) byName.set(name, new Set());
        byName.get(name)!.add(address);
      }

      const rowsByKey = new Map<string, AccountTokenBalance[]>();
      await Promise.all(
        [...byName.entries()].map(async ([name, addresses]) => {
          const rows = await getAccountTokenBalancesBatch([...addresses], name);
          for (const row of rows) {
            const key = `${row.address}-${name ?? "NULL"}`;
            const list = rowsByKey.get(key);
            if (list) list.push(row);
            else rowsByKey.set(key, [row]);
          }
        })
      );

      return keys.map((key) => rowsByKey.get(key) ?? []);
    }
  );

// --- handler logic (ported unchanged from token_handler.ts) ---

const getAccountTokens = async (
  loader: BalancesLoader,
  address: string,
  name?: string | null,
  allEntityRetired?: boolean | null
) => {
  const balances = await loader.load(balancesKey(address, name));

  const tokens: any = {};
  for (const curr of balances) {
    if (!tokens[curr.name]) {
      tokens[curr.name] = {
        contractAddress: curr.contractAddress,
        description: curr.description,
        image: curr.image,
        tokens: {},
      };
    }
    tokens[curr.name].tokens[curr.tokenId] = {
      collection: curr.collection,
      amount: Number(curr.amount),
      minted: Number(curr.minted),
      retired: Number(curr.retired),
    };
  }

  // if allEntityRetired: for retired values, count all retired ever (from any
  // address) for the tokens minted to this address
  if (allEntityRetired) {
    for (const [key, value] of Object.entries(tokens)) {
      const ids = Object.entries((value as any).tokens)
        .map(([key2, value2]: any[]) => {
          tokens[key].tokens[key2].retired = 0;
          if (value2.minted !== 0) return key2;
          return null;
        })
        .filter((t) => t !== null) as string[];

      const retiredTokens = await getTokenRetiredAmountSUM(ids);
      retiredTokens.forEach((t) => {
        tokens[key].tokens[t.id].retired = Number(t.amount);
      });
    }
  }

  Object.entries(tokens).forEach(([key, value]: any[]) => {
    Object.entries(value.tokens).forEach(([key2, value2]: any[]) => {
      if (value2.amount === 0 && value2.minted === 0 && value2.retired === 0)
        delete tokens[key].tokens[key2];
    });
    if (Object.keys(tokens[key].tokens).length === 0) delete tokens[key];
  });

  return tokens;
};

const getTokensTotalByAddress = async (
  loader: BalancesLoader,
  address: string,
  name?: string | null,
  allEntityRetired?: boolean | null
) => {
  const tokens = await getAccountTokens(loader, address, name, allEntityRetired);
  Object.keys(tokens).forEach((key) => {
    const newTokens: any = {};
    Object.values(tokens[key].tokens).forEach((t: any) => {
      if (!newTokens[t.collection]) {
        newTokens[t.collection] = {
          amount: t.amount,
          minted: t.minted,
          retired: t.retired,
        };
      } else {
        newTokens[t.collection].amount += t.amount;
        newTokens[t.collection].minted += t.minted;
        newTokens[t.collection].retired += t.retired;
      }
    });
    tokens[key].tokens = newTokens;
  });
  return tokens;
};

const getTokensTotalForEntities = async (
  loader: BalancesLoader,
  address: string,
  name?: string | null,
  allEntityRetired?: boolean | null
) => {
  const entities = await getEntityDeviceAccounts(address);

  const tokens = entities.map(async (entity: any) => {
    const entityTokens = await getTokensTotalByAddress(
      loader,
      entity.accounts.find((a: any) => a.name === "admin")?.address,
      name,
      allEntityRetired
    );
    return { entity: entity.id, tokens: entityTokens };
  });

  const tokensTotal = await Promise.all(tokens);

  return tokensTotal.filter((t) => Object.keys(t.tokens).length > 0);
};

const getTokensTotalForCollection = async (
  loader: BalancesLoader,
  did: string,
  name?: string | null,
  allEntityRetired?: boolean | null
) => {
  const entities = await getEntityAccountsByIidContext(
    JSON.stringify([{ key: "class", val: did }])
  );

  const tokens = entities.map(async (entity) => {
    const entityTokens = await getTokensTotalByAddress(
      loader,
      (entity.accounts as any).find((a: any) => a.name === "admin")?.address,
      name,
      allEntityRetired
    );
    return { entity: entity.id, tokens: entityTokens };
  });

  const tokensTotal = await Promise.all(tokens);

  return tokensTotal.filter((t) => Object.keys(t.tokens).length > 0);
};

const getTokensTotalForCollectionAmounts = async (
  loader: BalancesLoader,
  did: string,
  name?: string | null,
  allEntityRetired?: boolean | null
) => {
  const tokens = await getTokensTotalForCollection(
    loader,
    did,
    name,
    allEntityRetired
  );
  const newTokens: any = {};
  tokens.forEach((t: any) => {
    Object.keys(t.tokens).forEach((key) => {
      const amounts: any = Object.values(t.tokens[key].tokens).reduce(
        (acc: any, curr: any) => {
          acc.amount += curr.amount;
          acc.minted += curr.minted;
          acc.retired += curr.retired;
          return acc;
        },
        { amount: 0, minted: 0, retired: 0 }
      );
      if (!newTokens[key]) {
        newTokens[key] = amounts;
      } else {
        newTokens[key].amount += amounts.amount;
        newTokens[key].retired += amounts.retired;
        newTokens[key].minted += amounts.minted;
      }
    });
  });
  return newTokens;
};

// --- grafast loadOne batch callbacks -------------------------------------
// Spec tuple: [address-or-did, name, allEntityRetired]. One shared balances
// DataLoader per grafast batch keeps the fan-out collapse behaviour.

export type TokenQuerySpec = readonly [
  string,
  string | null | undefined,
  boolean | null | undefined
];

const runBatch = (
  specs: ReadonlyArray<any>,
  fn: (
    loader: BalancesLoader,
    key: string,
    name?: string | null,
    allEntityRetired?: boolean | null
  ) => Promise<any>
): Promise<any[]> => {
  const loader = createBalancesLoader();
  return Promise.all(
    specs.map(([key, name, allEntityRetired]: TokenQuerySpec) =>
      fn(loader, key, name, allEntityRetired)
    )
  );
};

export const batchGetAccountTokens = (specs: ReadonlyArray<any>) =>
  runBatch(specs, getAccountTokens);

export const batchGetTokensTotalByAddress = (specs: ReadonlyArray<any>) =>
  runBatch(specs, getTokensTotalByAddress);

export const batchGetTokensTotalForEntities = (specs: ReadonlyArray<any>) =>
  runBatch(specs, getTokensTotalForEntities);

export const batchGetTokensTotalForCollection = (specs: ReadonlyArray<any>) =>
  runBatch(specs, getTokensTotalForCollection);

export const batchGetTokensTotalForCollectionAmounts = (
  specs: ReadonlyArray<any>
) => runBatch(specs, getTokensTotalForCollectionAmounts);
