import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { formatUnits, isAddressEqual, parseAbiItem, zeroAddress, type Address, type Hash } from "viem";

import { blockTime, ChainError, earliestLog, firstMint, firstSince, inTurn, tokenFacts, type ChainHistory, type Dated, type Kept, type Mint } from "./history.js";

export const READINESS_NAME = "brainchain_token_readiness";

/**
 * Uniswap's pool contracts on Robinhood Chain: the v4 pool manager and the v3 factory. Each is Uniswap's own bytecode on
 * Ethereum byte for byte, apart from the contract's own address inside it (compared on 2026-11-16).
 */
export const UNISWAP_V4 = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address;
export const UNISWAP_V3 = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address;

export const READINESS_TOOL: Tool = {
  name: READINESS_NAME,
  title: "How far along a Robinhood Chain token is",
  description:
    "How far along a Robinhood Chain token is, read from the chain: whether its contract is deployed, when its first tokens were minted, and when the first pools for it were created on Uniswap. " +
    "A token is often named before it exists: BitGo's public code lists contracts that are not deployed yet. " +
    "Each step that follows leaves a dated record on chain, and this tool reads them. " +
    "Pass the token's contract address as `token`; the `contract` of an entry from brainchain_custody_additions works. " +
    "`deployed` says whether a contract is at the address. For a deployed token, `token` holds the `name` and `symbol` the contract gives itself, its `decimals` and its `totalSupply`, counted in tokens and not in the token's smallest unit. " +
    "Whoever deployed the contract chose the name and symbol, so they do not prove which token it is. " +
    "`firstMint` is the first time tokens were created: `at`, the `block`, the `transaction` and `to`, the address that received them. It is left out for a token with nothing minted. " +
    "`pools` lists the first pool created for the token on Uniswap v4 and on Uniswap v3, earliest first: the `venue`, `at`, the `block`, the `transaction` and `pairedWith`, the other token's contract address, or ETH. " +
    "Only the first pool on each venue is listed. Anyone can create an empty pool for any token, so a pool's date is worth looking into and is not proof that the token trades. " +
    "Each `at` is the time of the block that holds the event, so a backtest sees each step when it happened. `readAt` is when the chain was read. " +
    "The tool answers one request at a time. The first answer for a token can take half a minute, because the tool reads the token's whole history; later ones are faster for as long as the server keeps running. " +
    "An answer that is not ready after 45 seconds says so, and asking again goes on from where it stopped. " +
    "Free, no key and no payment. Not advice.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: { token: { type: "string", description: "The token's contract address on Robinhood Chain: 0x followed by 40 hex characters." } },
    required: ["token"],
    additionalProperties: false,
  },
};

export interface Pool extends Dated {
  venue: "Uniswap v4" | "Uniswap v3";
  pairedWith: Address | "ETH";
}

export interface ReadinessBoard {
  chain: "Robinhood Chain";
  token: { contract: Address; name?: string; symbol?: string; decimals?: number; totalSupply?: string };
  readAt: string;
  deployed: boolean;
  firstMint?: Mint;
  pools?: Pool[];
}

/** A pool with its place in its block, which orders two pools created in one block. */
type PlacedPool = Pool & { index: number };
const inOrder = (a: PlacedPool, b: PlacedPool) => a.block - b.block || a.index - b.index;

/** What was found in the stretches already read: first mints, and first pools by venue and by which side of the pair the token is on. */
export interface ReadinessKept {
  mints: Kept<Mint>;
  pools: Kept<PlacedPool>;
}

const initializeEvent = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const poolCreatedEvent = parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)");

/** A venue's log of a new pool. A pool names its two tokens in address order. */
interface Created {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hash;
  pair: readonly [Address, Address];
}

/** A venue, and how it is asked for the pools created with `token` on one side of the pair. */
interface Venue {
  venue: Pool["venue"];
  created(reader: ChainHistory, token: Address, side: 0 | 1, fromBlock: bigint, toBlock: bigint): Promise<Created[]>;
}

const VENUES: Venue[] = [
  {
    venue: "Uniswap v4",
    created: async (reader, token, side, fromBlock, toBlock) => {
      const logs = await reader.getLogs({ address: UNISWAP_V4, event: initializeEvent, args: side === 0 ? { currency0: token } : { currency1: token }, fromBlock, toBlock, strict: true });
      return logs.map((log) => ({ ...log, pair: [log.args.currency0, log.args.currency1] }));
    },
  },
  {
    venue: "Uniswap v3",
    created: async (reader, token, side, fromBlock, toBlock) => {
      const logs = await reader.getLogs({ address: UNISWAP_V3, event: poolCreatedEvent, args: side === 0 ? { token0: token } : { token1: token }, fromBlock, toBlock, strict: true });
      return logs.map((log) => ({ ...log, pair: [log.args.token0, log.args.token1] }));
    },
  },
];

/**
 * The first pool created for `token` on each of Uniswap's two venues, earliest first, looking from the stretch that holds
 * block `start` on. The token can be on either side of a pair, so each venue is asked for both.
 */
async function firstPools(reader: ChainHistory, token: Address, start: bigint, newest: bigint, kept: Kept<PlacedPool>): Promise<Pool[]> {
  const tooMany = () => new ChainError(`More than 10,000 pools were created for ${token} in a single block, more than this tool can read.`);
  const found: (PlacedPool | undefined)[] = [];
  for (const side of [0, 1] as const) {
    for (const { venue, created } of VENUES) {
      const earliestIn = async (from: bigint, to: bigint): Promise<PlacedPool | undefined> => {
        const log = await earliestLog((low, high) => created(reader, token, side, low, high), from, to, () => true, tooMany);
        if (!log) return undefined;
        const other = log.pair[side === 0 ? 1 : 0];
        return { venue, at: await blockTime(reader, log.blockNumber), block: Number(log.blockNumber), transaction: log.transactionHash, pairedWith: isAddressEqual(other, zeroAddress) ? "ETH" : other, index: log.logIndex };
      };
      found.push(await firstSince(kept, `${token}:${venue}:${side}`, newest, earliestIn, start));
    }
  }
  const firstOn = new Map<Pool["venue"], PlacedPool>();
  for (const pool of found) if (pool && (!firstOn.has(pool.venue) || inOrder(pool, firstOn.get(pool.venue)!) < 0)) firstOn.set(pool.venue, pool);
  return [...firstOn.values()].sort(inOrder).map(({ index: _, ...pool }) => pool);
}

/**
 * Whether `token` is deployed, and the dated steps of its life so far: its first mint, and the first pool created for it
 * on each Uniswap venue. Pools are looked for from the stretch of the first mint, so one created in the days before it is
 * found and one created long before is not. A token with supply and no mint on record is searched from the beginning; one
 * with neither has nothing to trade and is not searched.
 */
export async function tokenReadiness(reader: ChainHistory, token: Address, kept: ReadinessKept, now = new Date()): Promise<ReadinessBoard> {
  const facts = await tokenFacts(reader, token);
  const readAt = now.toISOString();
  if (!facts) return { chain: "Robinhood Chain", token: { contract: token }, readAt, deployed: false };
  const { decimals, supply, name, symbol } = facts;
  const newest = await reader.getBlockNumber();
  const mint = await firstMint(reader, token, newest, kept.mints);
  const start = mint ? BigInt(mint.block) : supply > 0n ? 0n : undefined;
  return {
    chain: "Robinhood Chain",
    token: { contract: token, ...(name ? { name } : {}), ...(symbol ? { symbol } : {}), decimals, totalSupply: formatUnits(supply, decimals) },
    readAt,
    deployed: true,
    ...(mint ? { firstMint: mint } : {}),
    pools: start === undefined ? [] : await firstPools(reader, token, start, newest, kept.pools),
  };
}

const kept: ReadinessKept = { mints: new Map(), pools: new Map() };

export function readTokenReadiness(token: Address): Promise<ReadinessBoard> {
  return inTurn((reader) => tokenReadiness(reader, token, kept));
}
