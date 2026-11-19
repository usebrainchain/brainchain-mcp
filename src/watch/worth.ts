import { encodeAbiParameters, encodeFunctionData, formatUnits, getAddress, keccak256, multicall3Abi, parseAbi, parseAbiItem, parseAbiParameters, toHex, zeroAddress, type Address, type Hash, type Hex } from "viem";

import { blockTime, ChainError, noContract, tokenFacts, type ChainHistory } from "../history.js";
import { dollars, LOOKBACK_BLOCKS, priceFrom, quoteReserve, SCALE, significant, THIN_USD, USDG, WETH } from "../marketcap.js";
import { MULTICALL3 } from "../premiums.js";
import { UNISWAP_V4 } from "../readiness.js";
import type { Worth } from "./context.js";
import type { IndexedPool, PoolIndex } from "./pools.js";

const USDG_DECIMALS = 6;
const ETH_DECIMALS = 18;
/** How many of a token's deepest pools are checked for a trade before the read gives up on them. */
export const TRADED_CHECKS = 5;
/** How long ETH's price is kept. */
const ETH_MS = 60_000;
const POOLS_SLOT = 6n;
const LIQUIDITY_OFFSET = 3n;
const LOW_160 = (1n << 160n) - 1n;
const LOW_128 = (1n << 128n) - 1n;
const v3State = parseAbi(["function slot0() view returns (uint160)", "function liquidity() view returns (uint128)"]);
const extsload = parseAbi(["function extsload(bytes32[] slots) view returns (bytes32[] values)"]);
const swapV3 = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");
const swapV4 = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isEth = (currency: string) => same(currency, zeroAddress) || same(currency, WETH);
const ten = (decimals: number) => 10n ** BigInt(decimals);

interface Priced {
  pool: IndexedPool;
  usd: bigint;
  liquidityUsd: bigint;
  quote: "USDG" | "ETH";
}

/** Each pool's price and active liquidity now, read from state: v3 pools through Multicall3, v4 pools through the pool manager's storage. */
async function states(reader: ChainHistory, pools: readonly IndexedPool[], block: bigint): Promise<Map<string, { sqrtPriceX96: bigint; liquidity: bigint }>> {
  const found = new Map<string, { sqrtPriceX96: bigint; liquidity: bigint }>();
  const v3 = pools.filter((pool) => pool.version === 3);
  if (v3.length > 0) {
    const calls = v3.flatMap((pool) => (["slot0", "liquidity"] as const).map((functionName) => ({ target: pool.pool as Address, allowFailure: true, callData: encodeFunctionData({ abi: v3State, functionName }) })));
    const answers = await reader.readContract({ address: MULTICALL3, abi: multicall3Abi, functionName: "aggregate3", args: [calls], blockNumber: block });
    // The first word of each answer is the value: some forks return more after it in slot0.
    const word = (answer: { success: boolean; returnData: Hex } | undefined) => (answer?.success && answer.returnData.length >= 66 ? BigInt(answer.returnData.slice(0, 66)) : 0n);
    v3.forEach((pool, i) => found.set(pool.pool.toLowerCase(), { sqrtPriceX96: word(answers[2 * i]) & LOW_160, liquidity: word(answers[2 * i + 1]) & LOW_128 }));
  }
  const v4 = pools.filter((pool) => pool.version === 4);
  if (v4.length > 0) {
    const slots = v4.flatMap((pool) => {
      const state = BigInt(keccak256(encodeAbiParameters(parseAbiParameters("bytes32, uint256"), [pool.pool as Hash, POOLS_SLOT])));
      return [toHex(state, { size: 32 }), toHex(state + LIQUIDITY_OFFSET, { size: 32 })];
    });
    const values = await reader.readContract({ address: UNISWAP_V4, abi: extsload, functionName: "extsload", args: [slots], blockNumber: block });
    v4.forEach((pool, i) => found.set(pool.pool.toLowerCase(), { sqrtPriceX96: BigInt(values[2 * i]!) & LOW_160, liquidity: BigInt(values[2 * i + 1]!) & LOW_128 }));
  }
  return found;
}

/**
 * The block of a pool's last swap at or before `block`, looking back at most `LOOKBACK_BLOCKS`: the newest ten thousand
 * blocks first, then wider ranges, each of which the private endpoint reads in pieces.
 */
async function lastSwap(reader: ChainHistory, pool: IndexedPool, block: bigint): Promise<bigint | undefined> {
  const floor = block - LOOKBACK_BLOCKS + 1n > BigInt(pool.block) ? block - LOOKBACK_BLOCKS + 1n : BigInt(pool.block);
  let to = block;
  for (const width of [10_000n, 90_000n]) {
    if (to < floor) return undefined;
    const from = to - width + 1n > floor ? to - width + 1n : floor;
    const found = await swapsIn(reader, pool, from, to);
    if (found !== undefined) return found;
    to = from - 1n;
  }
  for (; to >= floor; to -= 200_000n) {
    const from = to - 199_999n > floor ? to - 199_999n : floor;
    const found = await swapsIn(reader, pool, from, to);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function swapsIn(reader: ChainHistory, pool: IndexedPool, from: bigint, to: bigint): Promise<bigint | undefined> {
  const logs =
    pool.version === 3
      ? await reader.getLogs({ address: pool.pool as Address, event: swapV3, fromBlock: from, toBlock: to })
      : await reader.getLogs({ address: UNISWAP_V4, event: swapV4, args: { id: pool.pool as Hash }, fromBlock: from, toBlock: to });
  return logs.length > 0 ? logs[logs.length - 1]!.blockNumber! : undefined;
}

/**
 * The deepest pool that traded within `LOOKBACK_BLOCKS`, among pools paired with USDG when any of those traded and with
 * ETH or WETH when none did, as brainchain_token_market_cap chooses. Only the deepest `TRADED_CHECKS` of each kind are
 * checked for a trade.
 */
async function deepest(
  reader: ChainHistory,
  isAsset: (currency: string) => boolean,
  assetDecimals: number,
  pools: readonly IndexedPool[],
  block: bigint,
  quotes: readonly ("USDG" | "ETH")[],
  ethUsd: () => Promise<bigint>,
): Promise<{ chosen?: Priced; unchecked: boolean }> {
  const state = await states(reader, pools, block);
  let unchecked = false;
  for (const quote of quotes) {
    const mine = pools.filter((pool) => (quote === "USDG" ? [pool.currency0, pool.currency1].some((currency) => same(currency, USDG)) : [pool.currency0, pool.currency1].some(isEth)));
    const live = mine.filter((pool) => {
      const read = state.get(pool.pool.toLowerCase());
      return read && read.sqrtPriceX96 > 0n && read.liquidity > 0n;
    });
    if (live.length === 0) continue;
    const quoteUsd = quote === "USDG" ? SCALE : await ethUsd();
    const quoteDecimals = quote === "USDG" ? USDG_DECIMALS : ETH_DECIMALS;
    const priced = live
      .map((pool): Priced => {
        const { sqrtPriceX96, liquidity } = state.get(pool.pool.toLowerCase())!;
        const assetIsCurrency0 = isAsset(pool.currency0);
        const inQuote = priceFrom(sqrtPriceX96, assetIsCurrency0, assetDecimals, quoteDecimals);
        return { pool, quote, usd: (inQuote * quoteUsd) / SCALE, liquidityUsd: (2n * quoteReserve(liquidity, sqrtPriceX96, assetIsCurrency0) * quoteUsd) / ten(quoteDecimals) };
      })
      .sort((a, b) => (b.liquidityUsd > a.liquidityUsd ? 1 : b.liquidityUsd < a.liquidityUsd ? -1 : 0));
    for (const candidate of priced.slice(0, TRADED_CHECKS)) if ((await lastSwap(reader, candidate.pool, block)) !== undefined) return { chosen: candidate, unchecked };
    if (priced.length > TRADED_CHECKS) unchecked = true;
  }
  return { unchecked };
}

export interface EthKept {
  usd?: bigint;
  until?: number;
}

/**
 * What a token is worth now, from the pools the index holds for it: each pool's price and liquidity from state, the
 * deepest one that traded, and the token's total supply. Nothing is searched for but the chosen pool's last swap.
 */
export async function indexedWorth(reader: ChainHistory, token: Address, index: PoolIndex, eth: EthKept = {}, clock = Date.now): Promise<Worth> {
  const block = await reader.getBlockNumber();
  const facts = await tokenFacts(reader, token, [], block);
  if (!facts) throw noContract(token);
  const pools = index.poolsOf(token).filter((pool) => [pool.currency0, pool.currency1].some((currency) => !same(currency, token) && (isEth(currency) || same(currency, USDG))));
  const none = `No pool on Uniswap v3 or v4 that pairs ${token} with USDG, ETH or WETH traded in the ${LOOKBACK_BLOCKS.toLocaleString("en-US")} blocks up to block ${block}, so there is no price for it there.`;
  if (pools.length === 0) throw new ChainError(none);
  const ethUsd = async () => {
    if (eth.usd !== undefined && (eth.until ?? 0) > clock()) return eth.usd;
    const pairs = index.basePools().filter((pool) => [pool.currency0, pool.currency1].some((currency) => same(currency, USDG)) && [pool.currency0, pool.currency1].some(isEth));
    const { chosen } = await deepest(reader, isEth, ETH_DECIMALS, pairs, block, ["USDG"], async () => SCALE);
    if (!chosen) throw new ChainError(`No pool paired with USDG traded for ETH by block ${block}, so ETH's price in dollars cannot be read.`);
    Object.assign(eth, { usd: chosen.usd, until: clock() + ETH_MS });
    return chosen.usd;
  };
  const { chosen, unchecked } = await deepest(reader, (currency) => same(currency, token), facts.decimals, pools, block, ["USDG", "ETH"], ethUsd);
  if (!chosen) {
    if (unchecked) throw new ChainError(`None of the ${TRADED_CHECKS} deepest pools that pair ${token} with USDG, ETH or WETH traded in the ${LOOKBACK_BLOCKS.toLocaleString("en-US")} blocks up to block ${block}.`);
    throw new ChainError(none);
  }
  const { pool } = chosen;
  const other = same(pool.currency0, token) ? pool.currency1 : pool.currency0;
  return {
    marketCapUsd: dollars((chosen.usd * facts.supply) / ten(facts.decimals)),
    priceUsd: significant(chosen.usd),
    supply: formatUnits(facts.supply, facts.decimals),
    liquidityUsd: dollars(chosen.liquidityUsd),
    thin: chosen.liquidityUsd < BigInt(THIN_USD) * SCALE,
    pool: { version: pool.version === 3 ? "Uniswap v3" : "Uniswap v4", ...(pool.version === 3 ? { address: pool.pool } : { id: pool.pool }), pairedWith: same(other, zeroAddress) ? "ETH" : getAddress(other) },
    asOf: { block: Number(block), at: await blockTime(reader, block) },
  };
}
