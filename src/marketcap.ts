import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { formatUnits, getAddress, isAddressEqual, parseAbiItem, zeroAddress, type Address, type Hash } from "viem";

import { BY_SYMBOL, TOKEN_INPUT } from "./custody.js";
import {
  blockOf,
  blockTime,
  ChainError,
  inTurn,
  noContract,
  remember,
  SETTLED_BLOCKS,
  STRETCH_BLOCKS,
  tokenFacts,
  tooMany,
  tooSlow,
  transferred,
  transfersStart,
  type ChainHistory,
  type Kept,
  type Moment,
} from "./history.js";
import { UNISWAP_V3, UNISWAP_V4 } from "./readiness.js";

export const MARKET_CAP_NAME = "brainchain_token_market_cap";

export const USDG = getAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
export const WETH = getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
const USDG_DECIMALS = 6;
const ETH_DECIMALS = 18;

/**
 * The endpoint searches 10,000,000 blocks for logs that name one value in each place, but only 100,000 for a request that
 * names several pools, and it takes at most 1,000 addresses and topic values in one request (both read on 2026-11-19).
 */
export const CHUNK_BLOCKS = 100_000n;
export const POOLS_PER_REQUEST = 900;
/** The pools weighed are the ones that traded this close to the block: about eight hours at ten blocks a second. */
export const RECENT_BLOCKS = 300_000n;
/** How far back the search for a trade goes when nothing traded that recently: about three and a half days. */
export const LOOKBACK_BLOCKS = 3_000_000n;
/** Depth is counted within this many percent of a pool's price, either way. */
export const DEPTH_PERCENT = 2;
/** Below this many dollars of depth within 2%, a $1,000 buy moves a pool's price about 2% or more. */
export const THIN_USD = 2_000;

export const MARKET_CAP_TOOL: Tool = {
  name: MARKET_CAP_NAME,
  title: "A Robinhood Chain token's market cap at a past block or time",
  description:
    "What a Robinhood Chain token's market cap was at a past block or time, or is now, read from the chain: its price in dollars, its supply, and the two multiplied. " +
    "The price is a pool's price right after the last swap at or before the block, read from that swap's log on Uniswap v3 or v4, in the deepest pool that pairs the token with USDG, which is counted as one dollar. " +
    "The pools weighed are the ones that traded in the 300,000 blocks up to the block, about eight hours at ten blocks a second. When none did, the search goes back 100,000 blocks at a time, up to 3,000,000 blocks, and weighs the pools that traded in the first stretch that has a trade. " +
    "When no pool paired with USDG traded there, the deepest pool paired with ETH or WETH is used, and its price is turned into dollars with ETH's price in ETH's deepest pool paired with USDG, read the same way at the same block and given as `ethUsd`. " +
    "A pool's depth is `depth2pctUsd`: the dollar value of what it holds between 2% under its price and 2% over it, from its active liquidity after its last swap, with liquidity added or removed around that price since then taken into account, held across that band. " +
    "Half of it is what a buy takes to move the price up 2%, and the other half what a sale takes to move it down 2%. " +
    `A pool with a \`depth2pctUsd\` under $${THIN_USD.toLocaleString("en-US")} is marked \`thin\`: a $1,000 buy moves its price about 2% or more, so its price says little. A thin pool is still used when it is the deepest. ` +
    "The supply is what the token's Transfer logs say was minted less what was burned up to the block, since Robinhood Chain's public endpoint keeps no state that old. " +
    "The tool checks the method at the newest block, where the same sum must equal the token's own totalSupply, and `supplyCheck` gives the `block` checked and whether the check `passed`. " +
    "If it did not, the token's supply does not follow its Transfer logs, and no past `supply` or `marketCapUsd` is given: `supplyCheck` then gives what the `transfers` add up to and the `totalSupply`. Without a cut-off, `supply` is the token's totalSupply at the newest block. " +
    "The market cap is the price times the whole supply, tokens held by the deployer or locked in a pool included. " +
    "Pass the token's contract address as `token`; the `contract` of an entry from brainchain_custody_additions works. " +
    BY_SYMBOL +
    "To read a past block, pass `atBlock`, a block number, or `at`, a time in ISO 8601 such as 2026-11-01T00:00:00Z, for the last block made at or before it. Without either, the tool reads the newest block. " +
    "In the answer, `asOf` gives the `block` the figures are for and when it was made (`at`), and `readAt` when the chain was read. `priceUsd`, `supply` and `marketCapUsd` are at that block, the price as the pool stood after `swap`, the swap it comes from, with its `block`, `at` and `transaction`. " +
    "`pool` is the pool used: its `version`, its `address` on Uniswap v3 or its `id` on Uniswap v4 with its `hooks`, the `pair`, `pairedWith`, the other token's contract address or ETH, its `fee`, its `depth2pctUsd` at the block and `thin`. " +
    "`chosen` says why that pool, and `pools` lists the pools it was weighed against, deepest first, each with its last swap's `block` and its `priceUsd` and `depth2pctUsd`. `token` holds the `contract` and the `name`, `symbol` and `decimals` the contract gives itself. " +
    "Anyone can create a pool for any token and trade in it, and whoever deployed a token chose its name, symbol and supply, so a price from a thin pool, or for a token whose origin you do not know, proves little. " +
    "The tool answers one request at a time, in turn with the other tools that read the chain. The first answer for a token can take half a minute, because the tool reads every pool created for it and its whole supply history; later ones are faster for as long as the server keeps running. " +
    "An answer that is not ready after 45 seconds says so, and asking again goes on from where it stopped. " +
    "Free, no key and no payment. Not advice.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      token: TOKEN_INPUT,
      atBlock: { type: "integer", minimum: 0, description: "Optional: a block number. The figures are those at the end of that block." },
      at: { type: "string", description: "Optional, in place of atBlock: a time in ISO 8601, such as 2026-11-01T00:00:00Z. The figures are those at the last block made at or before it." },
    },
    required: ["token"],
    additionalProperties: false,
  },
};

/** A pool for the asset priced and a quote: a v3 pool by its address, a v4 pool by its id in the pool manager. */
export interface Pool {
  version: "Uniswap v3" | "Uniswap v4";
  key: Address | Hash;
  currency0: Address;
  currency1: Address;
  fee: number;
  hooks?: Address;
  created: bigint;
}

/** A pool's last swap in a range of blocks: where the pool stood after it. */
export interface Traded {
  pool: Pool;
  block: bigint;
  index: number;
  transaction: Hash;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
}

/** A pool that traded, priced: one asset in the quote and in dollars, and its depth within 2% at the block, all scaled by `SCALE`. */
interface Priced extends Traded {
  quote: "USDG" | "ETH";
  inQuote: bigint;
  usd: bigint;
  depthUsd: bigint;
}

export interface PoolEntry {
  version: Pool["version"];
  address?: Address;
  id?: Hash;
  hooks?: Address;
  pair: string;
  pairedWith: Address | "ETH";
  fee: number;
  depth2pctUsd: string;
  thin: boolean;
}

export interface MarketCapBoard {
  chain: "Robinhood Chain";
  token: { contract: Address; name?: string; symbol?: string; decimals: number };
  readAt: string;
  asOf: { block: number; at: string };
  priceUsd: string;
  /** Left out at a past block when the token's supply does not follow its Transfer logs. */
  supply?: string;
  marketCapUsd?: string;
  swap: { block: number; at: string; transaction: Hash };
  pool: PoolEntry;
  chosen: string;
  pools: (PoolEntry & { block: number; priceUsd: string })[];
  /** For a price read in ETH: ETH's own price in dollars, the swap it comes from and its pool. */
  ethUsd?: { priceUsd: string; swap: { block: number; at: string; transaction: Hash }; pool: PoolEntry };
  supplyCheck?: { block: number; passed: boolean; transfers?: string; totalSupply?: string };
}

/** What was read already: where tokens' transfers begin, pools created in each stretch, swaps in each chunk, liquidity changes, mints and burns, block times. */
export interface CapKept {
  starts: Kept<bigint>;
  pools: Map<string, Promise<Pool[]>>;
  swaps: Map<string, Promise<Map<string, Traded>>>;
  changes: Map<string, Promise<bigint>>;
  supply: Map<string, Promise<bigint>>;
  times: Map<string, Promise<bigint>>;
  /** Each set of pairs' pools found so far, from one block through another: a later read scans only the blocks after. */
  index: Map<string, { from: bigint; through: bigint; pools: Pool[] }>;
}

/** Ranges up to this many blocks are searched in one request; longer ones a stretch at a time. */
export const ONE_RANGE = 200_000n;

const poolCreated = parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)");
const initialize = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");
const swapV3 = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");
const swapV4 = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
const mintV3 = parseAbiItem("event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)");
const burnV3 = parseAbiItem("event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)");
const modifyLiquidity = parseAbiItem("event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)");

/** Every log in a range: one with more logs than the endpoint returns, or one it takes too long to search, is read in halves. */
async function allLogs<L>(read: (from: bigint, to: bigint) => Promise<L[]>, from: bigint, to: bigint, full: () => Error): Promise<L[]> {
  const logs = await read(from, to).catch((error: unknown) => {
    if (from < to && (tooMany(error) || tooSlow(error))) return undefined;
    throw tooMany(error) ? full() : error;
  });
  if (logs) return logs;
  const middle = (from + to) / 2n;
  return [...(await allLogs(read, from, middle, full)), ...(await allLogs(read, middle + 1n, to, full))];
}

/** A read of a range that cannot change any more is kept; one that reaches the newest blocks is read again next time. */
const settled = <T>(kept: Map<string, Promise<T>>, name: string, to: bigint, newest: bigint, read: () => Promise<T>) => (to + SETTLED_BLOCKS > newest ? read() : remember(kept, name, read));

const sorted = (a: Address, b: Address): [Address, Address] => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);
const same = (a: Address, b: Address) => isAddressEqual(a, b);

/**
 * The pools on Uniswap v3 and v4 created from `from` through `to` that pair one of `pairs`, read in one range when it is
 * short and a stretch at a time when it is not. A whole stretch that has settled is kept. Each pair is asked for by both
 * its tokens, one value in each place, which the endpoint searches over a whole stretch; a v3 pool cannot hold ETH itself.
 */
async function scanPools(reader: ChainHistory, pairs: readonly [Address, Address][], from: bigint, to: bigint, newest: bigint, kept: CapKept): Promise<Pool[]> {
  const full = () => new ChainError("More than 10,000 pools were created for one pair in a single block, more than this tool can read.");
  const ranges: [bigint, bigint][] = [];
  if (to - from < ONE_RANGE) ranges.push([from, to]);
  else for (let start = from; start <= to; start = (start / STRETCH_BLOCKS + 1n) * STRETCH_BLOCKS) ranges.push([start, (start / STRETCH_BLOCKS + 1n) * STRETCH_BLOCKS - 1n < to ? (start / STRETCH_BLOCKS + 1n) * STRETCH_BLOCKS - 1n : to]);
  const found: Pool[] = [];
  for (const [start, end] of ranges) {
    for (const [currency0, currency1] of pairs) {
      if (!same(currency0, zeroAddress)) {
        found.push(
          ...(await settled(kept.pools, `v3:${currency0}:${currency1}:${start}-${end}`, end, newest, async () =>
            (await allLogs((low, high) => reader.getLogs({ address: UNISWAP_V3, event: poolCreated, args: { token0: currency0, token1: currency1 }, fromBlock: low, toBlock: high, strict: true }), start, end, full)).map(
              (log): Pool => ({ version: "Uniswap v3", key: getAddress(log.args.pool), currency0, currency1, fee: log.args.fee, created: log.blockNumber }),
            ),
          )),
        );
      }
      found.push(
        ...(await settled(kept.pools, `v4:${currency0}:${currency1}:${start}-${end}`, end, newest, async () =>
          (await allLogs((low, high) => reader.getLogs({ address: UNISWAP_V4, event: initialize, args: { currency0, currency1 }, fromBlock: low, toBlock: high, strict: true }), start, end, full)).map(
            (log): Pool => ({ version: "Uniswap v4", key: log.args.id, currency0, currency1, fee: log.args.fee, hooks: getAddress(log.args.hooks), created: log.blockNumber }),
          ),
        )),
      );
    }
  }
  return found;
}

/**
 * The pools on Uniswap v3 and v4 created by `upTo` that pair one of `assets` with one of `quotes`, from block `from` on.
 * What was found is kept as an index through the newest block, so the next read for the same pairs scans only the blocks
 * after it: a token's pools are searched once from its start, and then a few blocks at a time.
 */
async function poolsFor(reader: ChainHistory, assets: readonly Address[], quotes: readonly Address[], from: bigint, upTo: bigint, newest: bigint, kept: CapKept): Promise<Pool[]> {
  const pairs = assets.flatMap((asset) => quotes.filter((quote) => !same(asset, quote)).map((quote) => sorted(asset, quote)));
  const key = pairs.map((pair) => pair.join(":")).join(",").toLowerCase();
  const known = kept.index.get(key);
  const covered = known !== undefined && known.from <= from;
  if (!covered || known.through < upTo) {
    const scanned = await scanPools(reader, pairs, covered ? known.through + 1n : from, newest, newest, kept);
    kept.index.set(key, { from: covered ? known.from : from, through: newest, pools: [...(covered ? known.pools : []), ...scanned] });
  }
  return kept.index.get(key)!.pools.filter((pool) => pool.created <= upTo);
}

/** The later of two swaps, in chain order. */
const later = (a: Traded, b: Traded) => (a.block > b.block || (a.block === b.block && a.index > b.index) ? a : b);

/**
 * Each pool's last swap from block `from` to `to`, by the pool's key. Several pools go in one request, as many as the
 * endpoint takes, over at most `CHUNK_BLOCKS`.
 */
async function swapsIn(reader: ChainHistory, pools: readonly Pool[], from: bigint, to: bigint): Promise<Map<string, Traded>> {
  const last = new Map<string, Traded>();
  const keep = (swap: Traded) => {
    const earlier = last.get(swap.pool.key);
    last.set(swap.pool.key, earlier ? later(earlier, swap) : swap);
  };
  const full = () => new ChainError("A pool logged more than 10,000 swaps in a single block, more than this tool can read.");
  const byKey = new Map(pools.map((pool) => [pool.key.toLowerCase(), pool]));
  for (const version of ["Uniswap v3", "Uniswap v4"] as const) {
    const these = pools.filter((pool) => pool.version === version);
    for (let i = 0; i < these.length; i += POOLS_PER_REQUEST) {
      const batch = these.slice(i, i + POOLS_PER_REQUEST);
      if (version === "Uniswap v3") {
        const logs = await allLogs((low, high) => reader.getLogs({ address: batch.map(({ key }) => key as Address), event: swapV3, fromBlock: low, toBlock: high, strict: true }), from, to, full);
        for (const log of logs) {
          const pool = byKey.get(log.address.toLowerCase());
          if (pool) keep({ pool, block: log.blockNumber, index: log.logIndex, transaction: log.transactionHash, sqrtPriceX96: log.args.sqrtPriceX96, liquidity: log.args.liquidity, tick: log.args.tick });
        }
      } else {
        const logs = await allLogs((low, high) => reader.getLogs({ address: UNISWAP_V4, event: swapV4, args: { id: batch.map(({ key }) => key as Hash) }, fromBlock: low, toBlock: high, strict: true }), from, to, full);
        for (const log of logs) {
          const pool = byKey.get(log.args.id.toLowerCase());
          if (pool) keep({ pool, block: log.blockNumber, index: log.logIndex, transaction: log.transactionHash, sqrtPriceX96: log.args.sqrtPriceX96, liquidity: log.args.liquidity, tick: log.args.tick });
        }
      }
    }
  }
  return last;
}

/** The pools that traded and the first block searched; `recent` when they traded within `RECENT_BLOCKS` of the block. */
interface Window {
  swaps: Traded[];
  from: bigint;
  recent: boolean;
}

/**
 * The last swap of each pool that traded in the `RECENT_BLOCKS` up to `block`, read `CHUNK_BLOCKS` at a time, newest first.
 * When none did, the search goes on back to `LOOKBACK_BLOCKS` and stops at the first chunk with a trade. A chunk holds
 * only the swaps of pools created by its end, and every such pool is asked for, so a chunk that has settled is kept
 * under `name` whatever block the answer is for.
 */
async function lastSwaps(reader: ChainHistory, name: string, pools: readonly Pool[], block: bigint, newest: bigint, kept: CapKept): Promise<Window> {
  const found = new Map<string, Traded>();
  const earliest = pools.reduce((low, pool) => (pool.created < low ? pool.created : low), block + 1n);
  let to = block;
  let from = block + 1n;
  let recent = false;
  while (to >= earliest && block - to < LOOKBACK_BLOCKS) {
    // No pool here traded before the oldest was created, so a chunk starts no earlier than that.
    from = (to / CHUNK_BLOCKS) * CHUNK_BLOCKS > earliest ? (to / CHUNK_BLOCKS) * CHUNK_BLOCKS : earliest;
    const end = to;
    const live = pools.filter((pool) => pool.created <= end);
    const chunk = await settled(kept.swaps, `${name}:${from}-${end}`, end, newest, () => swapsIn(reader, live, from, end));
    if (found.size === 0 && chunk.size > 0) recent = block - end < RECENT_BLOCKS;
    for (const [key, swap] of chunk) if (!found.has(key)) found.set(key, swap);
    to = from - 1n;
    if (found.size > 0 && block - to >= RECENT_BLOCKS) break;
  }
  return { swaps: [...found.values()], from, recent };
}

const after = (swap: Traded, log: { blockNumber: bigint; logIndex: number }) => log.blockNumber > swap.block || (log.blockNumber === swap.block && log.logIndex > swap.index);
const around = (swap: Traded, lower: number, upper: number) => lower <= swap.tick && swap.tick < upper;
const changesFull = () => new ChainError("A pool logged more than 10,000 changes of liquidity in a single block, more than this tool can read.");

/** What liquidity was added to or removed from `swap`'s pool after it and up to `block`, around the price it left, read for that pool alone. */
async function changeOf(reader: ChainHistory, swap: Traded, block: bigint): Promise<bigint> {
  const { pool } = swap;
  if (pool.version === "Uniswap v4") {
    const logs = await allLogs((low, high) => reader.getLogs({ address: UNISWAP_V4, event: modifyLiquidity, args: { id: pool.key as Hash }, fromBlock: low, toBlock: high, strict: true }), swap.block, block, changesFull);
    return logs.filter((log) => after(swap, log) && around(swap, log.args.tickLower, log.args.tickUpper)).reduce((sum, log) => sum + log.args.liquidityDelta, 0n);
  }
  const address = pool.key as Address;
  const added = await allLogs((low, high) => reader.getLogs({ address, event: mintV3, fromBlock: low, toBlock: high, strict: true }), swap.block, block, changesFull);
  const removed = await allLogs((low, high) => reader.getLogs({ address, event: burnV3, fromBlock: low, toBlock: high, strict: true }), swap.block, block, changesFull);
  const sum = (logs: typeof added | typeof removed) => logs.filter((log) => after(swap, log) && around(swap, log.args.tickLower, log.args.tickUpper)).reduce((total, log) => total + log.args.amount, 0n);
  return sum(added) - sum(removed);
}

/** The same for several v4 pools, read together `CHUNK_BLOCKS` at a time, by pool key. */
async function changesOf(reader: ChainHistory, swaps: readonly Traded[], from: bigint, block: bigint): Promise<Map<string, bigint>> {
  const logs: { blockNumber: bigint; logIndex: number; args: { id: Hash; tickLower: number; tickUpper: number; liquidityDelta: bigint } }[] = [];
  for (let low = from; low <= block; low += CHUNK_BLOCKS) {
    const high = low + CHUNK_BLOCKS - 1n < block ? low + CHUNK_BLOCKS - 1n : block;
    for (let i = 0; i < swaps.length; i += POOLS_PER_REQUEST) {
      const id = swaps.slice(i, i + POOLS_PER_REQUEST).map(({ pool }) => pool.key as Hash);
      logs.push(...(await allLogs((first, last) => reader.getLogs({ address: UNISWAP_V4, event: modifyLiquidity, args: { id }, fromBlock: first, toBlock: last, strict: true }), low, high, changesFull)));
    }
  }
  const of = (swap: Traded) => logs.filter((log) => log.args.id.toLowerCase() === swap.pool.key.toLowerCase() && after(swap, log) && around(swap, log.args.tickLower, log.args.tickUpper));
  return new Map(swaps.map((swap) => [swap.pool.key, of(swap).reduce((sum, log) => sum + log.args.liquidityDelta, 0n)]));
}

/**
 * Each pool's active liquidity at the end of `block`: what its last swap left, plus what was added or removed since
 * around the price that swap left, which is the only liquidity a swap meets there. The v4 pools are read together when
 * that takes fewer requests than one each, as it does for a token with many pools that trade now and then.
 */
async function liquidities(reader: ChainHistory, swaps: readonly Traded[], block: bigint, newest: bigint, kept: CapKept): Promise<bigint[]> {
  const name = (swap: Traded) => `${swap.pool.key}:${swap.block}:${swap.index}-${block}`;
  const unread = swaps.filter((swap) => swap.pool.version === "Uniswap v4" && !kept.changes.has(name(swap)));
  const from = unread.reduce((low, swap) => (swap.block < low ? swap.block : low), block);
  const requests = Number((block - from) / CHUNK_BLOCKS + 1n) * Math.ceil(unread.length / POOLS_PER_REQUEST);
  const together = unread.length > 1 && requests < unread.length ? await changesOf(reader, unread, from, block) : new Map<string, bigint>();
  const found: bigint[] = [];
  for (const swap of swaps) {
    const known = together.get(swap.pool.key);
    const changed = await settled(kept.changes, name(swap), block, newest, () => (known === undefined ? changeOf(reader, swap, block) : Promise.resolve(known)));
    const liquidity = swap.liquidity + changed;
    found.push(liquidity > 0n ? liquidity : 0n);
  }
  return found;
}

/** Fixed-point scale for prices and dollars: 36 places keep a price of a millionth of a cent exact to many digits. */
export const SCALE = 10n ** 36n;
const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const ten = (places: number) => 10n ** BigInt(places);

/** One whole asset in the quote, scaled by `SCALE`, from a pool's square-root price. The asset is currency0 or currency1. */
export function priceFrom(sqrtPriceX96: bigint, assetIsCurrency0: boolean, assetDecimals: number, quoteDecimals: number): bigint {
  const squared = sqrtPriceX96 * sqrtPriceX96;
  if (squared === 0n) return 0n;
  return assetIsCurrency0 ? (squared * ten(assetDecimals) * SCALE) / (Q192 * ten(quoteDecimals)) : (Q192 * ten(assetDecimals) * SCALE) / (squared * ten(quoteDecimals));
}

const sqrt = (value: bigint): bigint => {
  if (value < 2n) return value;
  let root = value;
  for (let next = (root + 1n) >> 1n; next < root; next = (next + value / next) >> 1n) root = next;
  return root;
};

/**
 * What a pool holds between `DEPTH_PERCENT` under its price and as much over it, in the quote's smallest unit, by Uniswap's
 * range formulas for `liquidity` across that band: the currency0 between the price and the top of the band, valued at the
 * price, and the currency1 between the bottom of the band and the price. The pool's active liquidity is taken to run across
 * the whole band, as it does to the next initialized tick.
 */
export function depthWithin(liquidity: bigint, sqrtPriceX96: bigint, assetIsCurrency0: boolean): bigint {
  if (sqrtPriceX96 === 0n || liquidity === 0n) return 0n;
  const squared = sqrtPriceX96 * sqrtPriceX96;
  const top = sqrt((squared * BigInt(100 + DEPTH_PERCENT)) / 100n);
  const bottom = sqrt((squared * BigInt(100 - DEPTH_PERCENT)) / 100n);
  const above0 = (liquidity * Q96 * (top - sqrtPriceX96)) / (top * sqrtPriceX96);
  const below1 = (liquidity * (sqrtPriceX96 - bottom)) / Q96;
  // The quote is currency1 when the asset is currency0.
  return assetIsCurrency0 ? below1 + (above0 * squared) / Q192 : above0 + (below1 * Q192) / squared;
}

/** A `SCALE`d dollar amount in dollars and cents, rounded half up. */
export function dollars(value: bigint): string {
  const cents = (value + SCALE / 200n) / (SCALE / 100n);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** A `SCALE`d price to `digits` significant digits, rounded half up and written out in full. */
export function significant(value: bigint, digits = 8): string {
  const drop = value.toString().length - digits;
  if (value === 0n || drop <= 0) return formatUnits(value, 36);
  const unit = ten(drop);
  return formatUnits(((value + unit / 2n) / unit) * unit, 36);
}

/** What the answer calls a currency of a pool. */
const nameOf = (currency: Address, symbol: string) => (same(currency, USDG) ? "USDG" : same(currency, WETH) ? "WETH" : same(currency, zeroAddress) ? "ETH" : symbol);

interface Asset {
  /** The addresses the asset goes by: a token's own, or WETH's and native ETH's for ETH. */
  addresses: readonly Address[];
  decimals: number;
  symbol: string;
}

interface Pricing {
  chosen: Priced;
  candidates: Priced[];
  quote: "USDG" | "ETH";
  /** How many pools paired with ETH or WETH traded beside the ones paired with USDG. */
  others: number;
  from: bigint;
  recent: boolean;
  eth?: Pricing;
}

/**
 * `asset`'s deepest pool at `block`: among the pools paired with USDG that traded, by `lastSwaps`'s window, the one with the
 * most depth within 2% in dollars at the block, and only when none did, the same among those paired with ETH or WETH, priced
 * through ETH's own deepest pool paired with USDG.
 */
async function deepest(reader: ChainHistory, name: string, asset: Asset, quotes: readonly Address[], start: bigint, block: bigint, newest: bigint, kept: CapKept): Promise<Pricing | undefined> {
  const pools = await poolsFor(reader, asset.addresses, quotes, start, block, newest, kept);
  const { swaps, from, recent } = await lastSwaps(reader, name, pools, block, newest, kept);
  if (swaps.length === 0) return undefined;
  const isUsdg = (swap: Traded) => same(swap.pool.currency0, USDG) || same(swap.pool.currency1, USDG);
  const inUsdg = swaps.filter(isUsdg);
  const quote = inUsdg.length > 0 ? "USDG" : "ETH";
  const set = quote === "USDG" ? inUsdg : swaps;
  const eth = quote === "ETH" ? await ethPrice(reader, block, newest, kept) : undefined;
  if (quote === "ETH" && !eth) throw new ChainError(`No pool paired with USDG traded for this token by block ${block}, and ETH's own price could not be read there, so the price cannot be given in dollars.`);
  const quoteUsd = quote === "USDG" ? SCALE : eth!.chosen.usd;
  const quoteDecimals = quote === "USDG" ? USDG_DECIMALS : ETH_DECIMALS;
  const liquidity = await liquidities(reader, set, block, newest, kept);
  const candidates = set.map((swap, i): Priced => {
    const assetIsCurrency0 = asset.addresses.some((address) => same(address, swap.pool.currency0));
    const inQuote = priceFrom(swap.sqrtPriceX96, assetIsCurrency0, asset.decimals, quoteDecimals);
    const depthUsd = (depthWithin(liquidity[i]!, swap.sqrtPriceX96, assetIsCurrency0) * quoteUsd) / ten(quoteDecimals);
    return { ...swap, quote, inQuote, usd: (inQuote * quoteUsd) / SCALE, depthUsd };
  });
  candidates.sort((a, b) => (b.depthUsd > a.depthUsd ? 1 : b.depthUsd < a.depthUsd ? -1 : later(a, b) === a ? -1 : 1));
  return { chosen: candidates[0]!, candidates, quote, others: swaps.length - set.length, from, recent, ...(eth ? { eth } : {}) };
}

const ETH: Asset = { addresses: [WETH, zeroAddress], decimals: ETH_DECIMALS, symbol: "ETH" };

/** ETH's price in dollars at `block`, from its deepest pool paired with USDG. */
function ethPrice(reader: ChainHistory, block: bigint, newest: bigint, kept: CapKept): Promise<Pricing | undefined> {
  return deepest(reader, "eth", ETH, [USDG], 0n, block, newest, kept);
}

const thin = (depthUsd: bigint) => depthUsd < BigInt(THIN_USD) * SCALE;

function entry(priced: Priced, symbol: string): PoolEntry {
  const { pool } = priced;
  const [other, own] = (priced.quote === "USDG" ? same(pool.currency0, USDG) : same(pool.currency0, WETH) || same(pool.currency0, zeroAddress)) ? [pool.currency0, pool.currency1] : [pool.currency1, pool.currency0];
  return {
    version: pool.version,
    ...(pool.version === "Uniswap v3" ? { address: pool.key as Address } : { id: pool.key as Hash, hooks: pool.hooks! }),
    pair: `${nameOf(own, symbol)}/${nameOf(other, symbol)}`,
    pairedWith: same(other, zeroAddress) ? "ETH" : other,
    fee: pool.fee,
    depth2pctUsd: dollars(priced.depthUsd),
    thin: thin(priced.depthUsd),
  };
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Why the answer uses the pool it does, in a sentence or two. */
function chosenBecause(pricing: Pricing, block: bigint): string {
  const { candidates, quote, others, from, recent } = pricing;
  const window = recent
    ? `in the ${count(Number(block - from + 1n), "block")} up to block ${block}`
    : `in blocks ${from} to ${from + CHUNK_BLOCKS - 1n}, the latest trades in the ${count(Number(block - from + 1n), "block")} up to block ${block}`;
  const paired = quote === "USDG" ? "USDG" : "ETH or WETH";
  const which = candidates.length === 1 ? `The only pool paired with ${paired} that traded ${window}` : `The deepest of the ${count(candidates.length, "pool")} paired with ${paired} that traded ${window}`;
  if (quote === "USDG") return `${which}${others > 0 ? `; ${count(others, "pool")} paired with ETH or WETH also traded there` : ""}.`;
  return `No pool paired with USDG traded there. ${which}, priced in dollars through ETH's deepest pool paired with USDG at the same block.`;
}

/** The mints less the burns of `token` up to `block` and up to `newest`, a stretch at a time from `start`, as makers.ts adds up a wallet's transfers. */
async function minted(reader: ChainHistory, token: Address, start: bigint, block: bigint, newest: bigint, kept: Map<string, Promise<bigint>>): Promise<{ then: bigint; now: bigint }> {
  let then = 0n;
  let now = 0n;
  for (let from = (start / STRETCH_BLOCKS) * STRETCH_BLOCKS; from <= newest; from += STRETCH_BLOCKS) {
    const end = from + STRETCH_BLOCKS - 1n < newest ? from + STRETCH_BLOCKS - 1n : newest;
    const parts: [bigint, bigint][] = from <= block && block < end ? [[from, block], [block + 1n, end]] : [[from, end]];
    for (const [low, high] of parts) {
      const net = (await transferred(reader, token, zeroAddress, "from", low, high, newest, kept)) - (await transferred(reader, token, zeroAddress, "to", low, high, newest, kept));
      now += net;
      if (high <= block) then += net;
    }
  }
  return { then, now };
}

/**
 * `token`'s price, supply and market cap at the newest block, or at `moment`. The price is the deepest pool's after its
 * last swap (see `deepest`); a past supply is rebuilt from the token's mints and burns, and given only when the same sum
 * comes to the token's totalSupply at the newest block.
 */
/**
 * `from`, when given, is a block known to be at or before the token's first transfer, such as the block its contract was
 * created in: the search for its pools starts there rather than at the start of the chain.
 */
export async function marketCap(reader: ChainHistory, token: Address, kept: CapKept, now = new Date(), moment?: Moment, from?: bigint): Promise<MarketCapBoard> {
  if (same(token, USDG)) throw new ChainError("USDG is the dollar this tool prices in: it counts one USDG as one dollar.");
  const newest = await reader.getBlockNumber();
  const facts = await tokenFacts(reader, token, [], newest);
  if (!facts) throw noContract(token);
  const { decimals, supply, name, symbol } = facts;
  const asOf = moment ? await blockOf(reader, moment, newest, kept.times) : { block: newest, at: await blockTime(reader, newest) };
  const start = from ?? (await transfersStart(reader, token, newest, kept.starts));
  if (start === undefined || start > asOf.block) throw new ChainError(`The contract at ${token} had logged no transfers by block ${asOf.block}, so nobody had traded it.`);
  const label = symbol || "token";
  const asset: Asset = same(token, WETH) ? ETH : { addresses: [token], decimals, symbol: label };
  const pricing = await deepest(reader, token.toLowerCase(), asset, same(token, WETH) ? [USDG] : [USDG, WETH, zeroAddress], start, asOf.block, newest, kept);
  if (!pricing) {
    throw new ChainError(
      `No pool on Uniswap v3 or v4 that pairs ${token} with USDG, ETH or WETH traded in the ${LOOKBACK_BLOCKS.toLocaleString("en-US")} blocks up to block ${asOf.block}, so there is no price for it there.`,
    );
  }
  const { chosen, candidates, eth } = pricing;
  const readAt = now.toISOString();
  const swapOf = async (swap: Traded) => ({ block: Number(swap.block), at: await blockTime(reader, swap.block), transaction: swap.transaction });

  let shown: { supply?: string; marketCapUsd?: string; supplyCheck?: MarketCapBoard["supplyCheck"] };
  const capOf = (amount: bigint) => ({ supply: formatUnits(amount, decimals), marketCapUsd: dollars((chosen.usd * amount) / ten(decimals)) });
  if (!moment) shown = capOf(supply);
  else {
    const sums = await minted(reader, token, start, asOf.block, newest, kept.supply);
    const passed = sums.now === supply && sums.then >= 0n;
    const supplyCheck = passed ? { block: Number(newest), passed } : { block: Number(newest), passed, transfers: formatUnits(sums.now, decimals), totalSupply: formatUnits(supply, decimals) };
    shown = { ...(passed ? capOf(sums.then) : {}), supplyCheck };
  }
  const { supplyCheck, ...figures } = shown;
  return {
    chain: "Robinhood Chain",
    token: { contract: token, ...(name ? { name } : {}), ...(symbol ? { symbol } : {}), decimals },
    readAt,
    asOf: { block: Number(asOf.block), at: asOf.at },
    priceUsd: significant(chosen.usd),
    ...figures,
    swap: await swapOf(chosen),
    pool: entry(chosen, label),
    chosen: chosenBecause(pricing, asOf.block),
    pools: candidates.map((candidate) => ({ ...entry(candidate, label), block: Number(candidate.block), priceUsd: significant(candidate.usd) })),
    ...(eth ? { ethUsd: { priceUsd: significant(eth.chosen.usd), swap: await swapOf(eth.chosen), pool: entry(eth.chosen, "ETH") } } : {}),
    ...(supplyCheck ? { supplyCheck } : {}),
  };
}

const kept: CapKept = { starts: new Map(), pools: new Map(), swaps: new Map(), changes: new Map(), supply: new Map(), times: new Map(), index: new Map() };

export function readMarketCap(token: Address, moment?: Moment): Promise<MarketCapBoard> {
  return inTurn((reader) => marketCap(reader, token, kept, new Date(), moment));
}
