import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createPublicClient, http, parseAbi, type Address, type PublicClient } from "viem";

export const PREMIUMS_NAME = "brainchain_stock_premiums";

/** The desks' mandate on Robinhood Chain: it lists each stock token's deepest USDG pool and Chainlink feed. */
export const MANDATE = "0xA76916D1b75a82776779fb9d7EB156A4E4a55099" as Address;
export const ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

const mandateAbi = parseAbi([
  "function tokenCount() view returns (uint256)",
  "function tokens(uint256) view returns (address)",
  "function venues(address) view returns (address pool, address feed, bool live)",
]);
const tokenAbi = parseAbi(["function symbol() view returns (string)", "function uiMultiplier() view returns (uint256)"]);
const poolAbi = parseAbi([
  "function token0() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80)"]);

export const PREMIUMS_TOOL: Tool = {
  name: PREMIUMS_NAME,
  title: "Stock premiums on Robinhood Chain",
  description:
    "What tokenized US stocks cost on Robinhood Chain against their Chainlink price right now: pool price, Chainlink price, " +
    "the premium in percent and the feed's age, for NVDA, SPY, AAPL, TSLA, GOOGL, META and MSFT. Read from the chain, free, no key " +
    "and no payment. Over a weekend the feeds stand still and the pools keep trading. " +
    "usMarketOpen is true during the regular session, 09:30 to 16:00 New York time, Monday to Friday; it does not know exchange holidays or early closes. " +
    "Prices are in USDG per token with each token's split multiplier applied. Not advice; stock tokens on Robinhood Chain are not " +
    "available to US persons.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export interface StockPremium {
  symbol: string;
  token: Address;
  pool: Address;
  poolPrice: string;
  chainlinkPrice: string;
  premiumPct: string;
  feedUpdatedAt: string;
  feedAgeSeconds: number;
}

export interface PremiumBoard {
  chain: "Robinhood Chain";
  readAt: string;
  usMarketOpen: boolean;
  stocks: StockPremium[];
}

export type ChainReader = Pick<PublicClient, "readContract" | "multicall">;

export function chainReader(rpc = ROBINHOOD_RPC): ChainReader {
  return createPublicClient({ transport: http(rpc) });
}

/** The regular NYSE session, 09:30 to 16:00 New York time, Monday to Friday; exchange holidays are not known here. */
export function usMarketOpen(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = part("weekday");
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minutes = (Number(part("hour")) % 24) * 60 + Number(part("minute"));
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

/** USDG units (6 decimals) as dollars and cents, rounded half up. */
const usd = (units: bigint): string => {
  const cents = (units + 5_000n) / 10_000n;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
};

/** USDG (6 decimals) for one whole stock token at the pool's current price. */
function spotFromSlot0(sqrtPriceX96: bigint, token0: Address): bigint {
  const squared = sqrtPriceX96 * sqrtPriceX96;
  return token0.toLowerCase() === USDG ? (10n ** 18n << 192n) / squared : (10n ** 18n * squared) >> 192n;
}

export async function stockPremiums(reader: ChainReader, now = new Date()): Promise<PremiumBoard> {
  const count = Number(await reader.readContract({ address: MANDATE, abi: mandateAbi, functionName: "tokenCount" }));
  const tokens = (await reader.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: false,
    contracts: Array.from({ length: count }, (_, i) => ({ address: MANDATE, abi: mandateAbi, functionName: "tokens" as const, args: [BigInt(i)] })),
  })) as Address[];
  const venues = (await reader.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: false,
    contracts: tokens.map((token) => ({ address: MANDATE, abi: mandateAbi, functionName: "venues" as const, args: [token] })),
  })) as [Address, Address, boolean][];
  const live = tokens.map((token, i) => ({ token, pool: venues[i]![0], feed: venues[i]![1], live: venues[i]![2] })).filter((v) => v.live);
  const reads = await reader.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: false,
    contracts: live.flatMap((v) => [
      { address: v.token, abi: tokenAbi, functionName: "symbol" as const },
      { address: v.token, abi: tokenAbi, functionName: "uiMultiplier" as const },
      { address: v.pool, abi: poolAbi, functionName: "token0" as const },
      { address: v.pool, abi: poolAbi, functionName: "slot0" as const },
      { address: v.feed, abi: feedAbi, functionName: "latestRoundData" as const },
    ]),
  });
  const at = Math.floor(now.getTime() / 1000);
  const stocks = live.map((v, i) => {
    const [symbol, multiplier, token0, slot0, round] = reads.slice(i * 5, i * 5 + 5) as [string, bigint, Address, [bigint, ...unknown[]], [bigint, bigint, bigint, bigint, bigint]];
    const spot = spotFromSlot0(slot0[0], token0);
    const feed = (round[1] * multiplier) / 10n ** 20n;
    const bps = feed === 0n ? 0 : Number(((spot - feed) * 1_000_000n) / feed) / 100;
    const updatedAt = Number(round[3]);
    return {
      symbol,
      token: v.token,
      pool: v.pool,
      poolPrice: usd(spot),
      chainlinkPrice: usd(feed),
      premiumPct: `${bps >= 0 ? "+" : ""}${(bps / 100).toFixed(2)}`,
      feedUpdatedAt: new Date(updatedAt * 1000).toISOString(),
      feedAgeSeconds: Math.max(0, at - updatedAt),
    };
  });
  return { chain: "Robinhood Chain", readAt: now.toISOString(), usMarketOpen: usMarketOpen(now), stocks };
}

let reader: ChainReader | undefined;

export function readPremiums(): Promise<PremiumBoard> {
  reader ??= chainReader();
  return stockPremiums(reader);
}
