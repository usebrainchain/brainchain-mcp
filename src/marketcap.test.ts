import { readFileSync } from "node:fs";

import { decodeFunctionData, encodeFunctionResult, getAddress, InvalidInputRpcError, multicall3Abi, parseAbi, RpcRequestError, zeroAddress, type Address, type Hash, type Hex } from "viem";
import { describe, expect, it } from "vitest";

import { ChainError, type ChainHistory } from "./history.js";
import {
  CHUNK_BLOCKS,
  dollars,
  LOOKBACK_BLOCKS,
  MARKET_CAP_NAME,
  MARKET_CAP_TOOL,
  marketCap,
  POOLS_PER_REQUEST,
  priceFrom,
  quoteReserve,
  RECENT_BLOCKS,
  SCALE,
  significant,
  THIN_USD,
  USDG,
  WETH,
  type CapKept,
} from "./marketcap.js";
import { MULTICALL3 } from "./premiums.js";
import { UNISWAP_V3, UNISWAP_V4 } from "./readiness.js";

const CASHCAT = getAddress("0x020bfc650a365f8bb26819deaabf3e21291018b4");
const LAUNCHER = getAddress("0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb");
const OTHER = getAddress("0xb97e4298c7f5f55360d207a6196125376675b3ea");
const V3_CASHCAT_USDG = getAddress("0x4b0c312ffbb068f6a0bea128759e35d94b94d0e1");
const V3_ETH_USDG = getAddress("0x69bfaf19c9f377bb306a89aed9f6b07e2c1a8d9a");
const hash = (byte: string) => `0x${byte.repeat(32)}` as Hash;
const DEEP = hash("a9");
const SECOND = hash("ee");
const EMPTY = hash("8f");
const ETH_POOL = hash("15");
const NEWEST = 118_000_000n;
const CUTOFF = 21_401_123n;
const TOKENS = 10n ** 18n;
const fresh = (): CapKept => ({ starts: new Map(), pools: new Map(), swaps: new Map(), changes: new Map(), supply: new Map(), times: new Map() });

interface Token {
  decimals: number;
  supply: bigint;
  name: string;
  symbol: string;
  transfers: { block: bigint; from: Address; to: Address; value: bigint }[];
}
interface Created {
  version: 3 | 4;
  key: Address | Hash;
  currency0: Address;
  currency1: Address;
  fee: number;
  block: bigint;
}
interface Swapped {
  key: Address | Hash;
  block: bigint;
  index: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
}
interface Changed {
  key: Address | Hash;
  block: bigint;
  index: number;
  tickLower: number;
  tickUpper: number;
  delta: bigint;
}

const cashCat = (more: Partial<Token> = {}): Token => ({
  decimals: 18,
  supply: 1_000_000_000n * TOKENS,
  name: "Cash Cat",
  symbol: "CASHCAT",
  // Minted at launch, a fifth of it burned later, then traded.
  transfers: [
    { block: 88_836n, from: zeroAddress, to: LAUNCHER, value: 1_250_000_000n * TOKENS },
    { block: 5_000_000n, from: LAUNCHER, to: zeroAddress, value: 250_000_000n * TOKENS },
    { block: 30_000_000n, from: LAUNCHER, to: OTHER, value: 1_000_000n * TOKENS },
  ],
  ...more,
});

const POOLS: Created[] = [
  { version: 4, key: DEEP, currency0: CASHCAT, currency1: USDG, fee: 2690, block: 10_435_412n },
  { version: 4, key: SECOND, currency0: CASHCAT, currency1: USDG, fee: 5000, block: 15_000_000n },
  { version: 4, key: EMPTY, currency0: CASHCAT, currency1: USDG, fee: 2786, block: 12_000_000n },
  { version: 3, key: V3_CASHCAT_USDG, currency0: CASHCAT, currency1: USDG, fee: 10_000, block: 3_000_000n },
  { version: 4, key: ETH_POOL, currency0: zeroAddress, currency1: CASHCAT, fee: 10_000, block: 820_611n },
  { version: 3, key: V3_ETH_USDG, currency0: WETH, currency1: USDG, fee: 500, block: 50_000n },
];

// The first three are Cash Cat's pools as Robinhood Chain logged their last swaps before 2026-07-28T07:09:00Z; the rest are made up.
const SWAPS: Swapped[] = [
  { key: DEEP, block: 21_300_000n, index: 0, sqrtPriceX96: 14_000_000_000_000_000_000_000n, liquidity: 10n ** 18n, tick: -310_000 },
  { key: DEEP, block: 21_400_710n, index: 3, sqrtPriceX96: 15_495_418_308_450_789_825_008n, liquidity: 1_200_031_423_038_842_730n, tick: -308_962 },
  { key: SECOND, block: 21_397_459n, index: 1, sqrtPriceX96: 15_501_983_905_482_537_689_581n, liquidity: 435_831_963_875_960_719n, tick: -308_953 },
  { key: EMPTY, block: 21_389_814n, index: 0, sqrtPriceX96: 15_588_957_605_035_019_202_092n, liquidity: 46_176_160_078_846n, tick: -308_842 },
  { key: V3_CASHCAT_USDG, block: 21_397_457n, index: 7, sqrtPriceX96: 15_536_782_863_072_509_269_891n, liquidity: 312_551_692_710_869_291n, tick: -308_900 },
  // 50,000 Cash Cat to the ETH, and ETH at 2,000 USDG.
  { key: ETH_POOL, block: 21_400_000n, index: 2, sqrtPriceX96: 17_715_955_711_429_571_029_610_171_616_072n, liquidity: 3n * 10n ** 22n, tick: 108_000 },
  { key: V3_ETH_USDG, block: 21_401_000n, index: 0, sqrtPriceX96: 3_543_191_142_285_914_205_922_034n, liquidity: 10n ** 22n, tick: -198_000 },
];

const tokenAbi = parseAbi(["function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)", "function name() view returns (string)", "function symbol() view returns (string)"]);
const rpcError = (message: string) => new InvalidInputRpcError(new RpcRequestError({ body: {}, error: { code: -32000, message }, url: "https://rpc.example" }));

interface Asked {
  event: string;
  from: bigint;
  to: bigint;
  /** How many pools or ids the request named. */
  named: number;
}

/**
 * Robinhood Chain as `marketCap` meets it, held to the public endpoint's limits as read on 2026-11-19: 10,000 logs a
 * request, 1,000 addresses and topic values, and 100,000 blocks for a request that names several values in one place.
 */
function chain({ tokens = { [CASHCAT]: cashCat() } as Record<Address, Token>, pools = POOLS, swaps = SWAPS, changes = [] as Changed[], newest = NEWEST } = {}) {
  const asked: Asked[] = [];
  const time = (block: bigint) => 1_746_000_000 + Number(block / 10n);
  const reader = {
    async getBlockNumber() {
      return newest;
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      if (blockNumber > newest) throw new Error("no such block");
      return { timestamp: BigInt(time(blockNumber)) };
    },
    async getCode({ address }: { address: Address }) {
      return tokens[address] ? "0x6080" : undefined;
    },
    async readContract({ address, args, blockNumber }: { address: Address; args: [{ target: Address; callData: Hex }[]]; blockNumber?: bigint }) {
      expect(address).toBe(MULTICALL3);
      expect(blockNumber).toBe(newest);
      return args[0].map(({ target, callData }) => {
        const token = tokens[target];
        if (!token) return { success: true, returnData: "0x" };
        const { functionName } = decodeFunctionData({ abi: tokenAbi, data: callData });
        const result = { decimals: token.decimals, totalSupply: token.supply, name: token.name, symbol: token.symbol }[functionName];
        return { success: true, returnData: encodeFunctionResult({ abi: tokenAbi, functionName, result: result as never }) };
      });
    },
    async getLogs({ address, event, args = {}, fromBlock, toBlock }: { address: Address | Address[]; event: { name: string }; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }) {
      const addresses = Array.isArray(address) ? address : [address];
      const values = Object.values(args).flatMap((value) => (Array.isArray(value) ? value : [value]));
      const selectors = addresses.length + 1 + values.length;
      if (selectors > 1000) throw rpcError(`${selectors} address and topic selectors specified in query, but only 1000 are allowed`);
      const several = addresses.length > 1 || Object.values(args).some((value) => Array.isArray(value) && value.length > 1);
      const span = toBlock - fromBlock + 1n;
      if (several && span > CHUNK_BLOCKS) throw rpcError(`query spans ${span} blocks (${fromBlock} to ${toBlock}), but only 100000 are allowed for this request`);
      if (span > 10_000_000n) throw new Error(`asked for ${span} blocks, more than the endpoint searches`);
      asked.push({ event: event.name, from: fromBlock, to: toBlock, named: Math.max(addresses.length, ...Object.values(args).map((value) => (Array.isArray(value) ? value.length : 1))) });
      const within = (block: bigint) => block >= fromBlock && block <= toBlock;
      const among = (key: string, list: unknown) => (Array.isArray(list) ? list : [list]).some((value) => String(value).toLowerCase() === key.toLowerCase());
      const log = (key: string, block: bigint, index: number, logArgs: Record<string, unknown>) => ({ address: key.length === 42 ? key : UNISWAP_V4, blockNumber: block, logIndex: index, transactionHash: hash(index.toString(16).padStart(2, "0")), args: logArgs });
      if (event.name === "Transfer") {
        return (tokens[addresses[0]!]?.transfers ?? [])
          .filter(({ block, from, to }) => within(block) && (args.from === undefined || from === args.from) && (args.to === undefined || to === args.to))
          .map(({ block, from, to, value }, i) => log(addresses[0]!, block, i, { from, to, value }));
      }
      if (event.name === "PoolCreated" || event.name === "Initialize") {
        const version = event.name === "PoolCreated" ? 3 : 4;
        expect(addresses).toEqual([version === 3 ? UNISWAP_V3 : UNISWAP_V4]);
        const [first, second] = version === 3 ? [args.token0, args.token1] : [args.currency0, args.currency1];
        return pools
          .filter((pool) => pool.version === version && within(pool.block) && pool.currency0 === first && pool.currency1 === second)
          .map((pool) => log(version === 3 ? UNISWAP_V3 : pool.key, pool.block, 0, version === 3 ? { token0: first, token1: second, fee: pool.fee, pool: pool.key } : { id: pool.key, currency0: first, currency1: second, fee: pool.fee, hooks: zeroAddress }));
      }
      if (event.name === "Swap") {
        const v4 = addresses[0] === UNISWAP_V4;
        const found = swaps.filter((swap) => within(swap.block) && (v4 ? among(swap.key, args.id) : addresses.some((pool) => pool.toLowerCase() === swap.key.toLowerCase())));
        if (found.length > 10_000) throw rpcError("logs matched by query exceeds limit of 10000");
        return found.map(({ key, block, index, sqrtPriceX96, liquidity, tick }) => ({ ...log(key, block, index, { sqrtPriceX96, liquidity, tick }), ...(v4 ? { args: { id: key, sqrtPriceX96, liquidity, tick } } : {}) }));
      }
      return changes
        .filter((change) => among(change.key, event.name === "ModifyLiquidity" ? args.id : addresses[0]) && within(change.block) && (event.name === "ModifyLiquidity" || (event.name === "Mint" ? change.delta > 0n : change.delta < 0n)))
        .map(({ key, block, index, tickLower, tickUpper, delta }) =>
          log(key, block, index, event.name === "ModifyLiquidity" ? { id: key, tickLower, tickUpper, liquidityDelta: delta } : { tickLower, tickUpper, amount: delta < 0n ? -delta : delta }),
        );
    },
  };
  return { reader: reader as unknown as ChainHistory, asked, time };
}

const NOW = new Date("2026-11-19T08:00:00Z");
const at = (block: bigint) => new Date((1_746_000_000 + Number(block / 10n)) * 1000).toISOString();
const deepPool = { version: "Uniswap v4", id: DEEP, hooks: zeroAddress, pair: "CASHCAT/USDG", pairedWith: USDG, fee: 2690 } as const;

describe("the market cap tool's words", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const row = readme.split("\n").find((line) => line.startsWith(`| \`${MARKET_CAP_NAME}\` |`))!;
  const section = readme.slice(readme.indexOf("## Market cap at a time"), readme.indexOf("## Payments and limits"));

  it("say where the price comes from, how deep a pool is, when it is thin and how the supply is read", () => {
    const description = MARKET_CAP_TOOL.description!;
    for (const text of [description, section]) {
      expect(text).toContain("the deepest pool that pairs the token with USDG");
      expect(text).toContain("300,000 blocks up to the block");
      expect(text).toContain("3,000,000 blocks");
      expect(text).toContain("a $1,000 buy moves its price about 8% or more");
      expect(text).toContain("counted as if it were spread over every price");
      expect(text).toContain("minted less what was burned");
      expect(text).not.toMatch(/guarantee|will be listed|will list|insider|alpha|front-?run|likely|probab|forecast|—/i);
    }
    expect(description).toContain(`under $${THIN_USD.toLocaleString("en-US")} is marked \`thin\``);
    expect(section).toContain("less than $50,000 is marked `thin`");
    expect(description).toMatch(/Free, no key and no payment\. Not advice\.$/);
    expect(section.startsWith("## Market cap at a time\n")).toBe(true);
  });

  it("name the answer's fields as the answer does", () => {
    const fields = ["`priceUsd`", "`supply`", "`marketCapUsd`", "`asOf`", "`block`", "`at`", "`swap`", "`transaction`", "`pool`", "`version`", "`address`", "`id`", "`hooks`", "`pair`", "`pairedWith`", "`fee`", "`liquidityUsd`", "`thin`", "`chosen`", "`pools`", "`ethUsd`", "`supplyCheck`", "`passed`", "`token`", "`decimals`", "`readAt`", "`atBlock`"];
    for (const text of [MARKET_CAP_TOOL.description!, row]) for (const field of fields) expect(text, field).toContain(field);
  });

  it("are counted with the free tools that only read, and ask for the token and an optional cut-off", () => {
    expect(MARKET_CAP_TOOL.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(MARKET_CAP_TOOL.inputSchema).toMatchObject({ required: ["token"], additionalProperties: false });
    expect(Object.keys(MARKET_CAP_TOOL.inputSchema.properties!)).toEqual(["token", "atBlock", "at"]);
    expect(readme).toContain(`- \`${MARKET_CAP_NAME}\` `);
    expect(row).toContain("Free, no key.");
  });
});

describe("prices and dollars from a pool", () => {
  it("reads one asset in the quote from either side of a pool, in each token's own decimals", () => {
    // Cash Cat (18 decimals) is currency0 against USDG (6): sqrtPriceX96 15495418308450789825008 is 0.0382514094363... USDG.
    expect(significant(priceFrom(15_495_418_308_450_789_825_008n, true, 18, 6), 12)).toBe("0.0382514094363");
    // As currency1 against ETH: 50,000 Cash Cat to the ETH.
    expect(significant(priceFrom(17_715_955_711_429_571_029_610_171_616_072n, false, 18, 18))).toBe("0.00002");
    expect(priceFrom(0n, true, 18, 6)).toBe(0n);
  });

  it("counts a pool's active liquidity as the quote it would hold over every price", () => {
    const reserve = quoteReserve(1_200_031_423_038_842_730n, 15_495_418_308_450_789_825_008n, true);
    expect(dollars((2n * reserve * SCALE) / 10n ** 6n)).toBe("469403.51");
    expect(quoteReserve(10n ** 18n, 0n, false)).toBe(0n);
  });

  it("writes dollars to the cent and prices to eight significant digits, rounded half up", () => {
    expect(dollars(SCALE / 200n)).toBe("0.01");
    expect(dollars(SCALE / 200n - 1n)).toBe("0.00");
    expect(dollars(38_251_409_436n * (SCALE / 1000n))).toBe("38251409.44");
    expect(significant(123_456_785n * (SCALE / 10n ** 9n))).toBe("0.12345679");
    expect(significant(2n * SCALE)).toBe("2");
    expect(significant(0n)).toBe("0");
  });
});

describe("marketCap", () => {
  it("prices the token in its deepest pool paired with USDG that traded, and multiplies by the supply its mints and burns add up to", async () => {
    const { reader } = chain();
    const board = await marketCap(reader, CASHCAT, fresh(), NOW, { block: CUTOFF });
    expect(board).toEqual({
      chain: "Robinhood Chain",
      token: { contract: CASHCAT, name: "Cash Cat", symbol: "CASHCAT", decimals: 18 },
      readAt: NOW.toISOString(),
      asOf: { block: Number(CUTOFF), at: at(CUTOFF) },
      priceUsd: "0.038251409",
      supply: "1000000000",
      marketCapUsd: "38251409.44",
      swap: { block: 21_400_710, at: at(21_400_710n), transaction: hash("03") },
      pool: { ...deepPool, liquidityUsd: "469403.51", thin: false },
      chosen: "The deepest of the 4 pools paired with USDG that traded in the 301,124 blocks up to block 21401123; 1 pool paired with ETH or WETH also traded there.",
      pools: [
        { ...deepPool, liquidityUsd: "469403.51", thin: false, block: 21_400_710, priceUsd: "0.038251409" },
        { version: "Uniswap v4", id: SECOND, hooks: zeroAddress, pair: "CASHCAT/USDG", pairedWith: USDG, fee: 5000, liquidityUsd: "170551.98", thin: false, block: 21_397_459, priceUsd: "0.038283831" },
        { version: "Uniswap v3", address: V3_CASHCAT_USDG, pair: "CASHCAT/USDG", pairedWith: USDG, fee: 10_000, liquidityUsd: "122583.88", thin: false, block: 21_397_457, priceUsd: "0.038455904" },
        { version: "Uniswap v4", id: EMPTY, hooks: zeroAddress, pair: "CASHCAT/USDG", pairedWith: USDG, fee: 2786, liquidityUsd: "18.17", thin: true, block: 21_389_814, priceUsd: "0.038714619" },
      ],
      supplyCheck: { block: Number(NEWEST), passed: true },
    });
  });

  it("counts liquidity added or removed around the price after the last swap, and none placed elsewhere", async () => {
    const changes: Changed[] = [
      // Most of the deepest pool's liquidity leaves after its last swap, so the second pool is the deepest at the block.
      { key: DEEP, block: 21_400_800n, index: 0, tickLower: -310_000, tickUpper: -300_000, delta: -1_000_000_000_000_000_000n },
      // Changes away from the price, and one in the same block before the swap, are already in what the swap logged or meet no trade.
      { key: DEEP, block: 21_400_900n, index: 0, tickLower: -200_000, tickUpper: -100_000, delta: -200_000_000_000_000_000n },
      { key: DEEP, block: 21_400_710n, index: 1, tickLower: -310_000, tickUpper: -300_000, delta: -200_000_000_000_000_000n },
      // Read together with the other pools' changes from an earlier block, a change before the swap counts for nothing, whatever its place in its block.
      { key: DEEP, block: 21_395_000n, index: 9, tickLower: -310_000, tickUpper: -300_000, delta: -500_000_000_000_000_000n },
      // Liquidity minted around the price of the v3 pool counts as well.
      { key: V3_CASHCAT_USDG, block: 21_400_000n, index: 0, tickLower: -309_000, tickUpper: -308_800, delta: 312_551_692_710_869_291n },
    ];
    const board = await marketCap(chain({ changes }).reader, CASHCAT, fresh(), NOW, { block: CUTOFF });
    expect(board.pool).toMatchObject({ version: "Uniswap v3", address: V3_CASHCAT_USDG, liquidityUsd: "245167.76" });
    expect(board.priceUsd).toBe("0.038455904");
    expect(board.pools.map(({ liquidityUsd }) => liquidityUsd)).toEqual(["245167.76", "170551.98", "78244.16", "18.17"]);
  });

  it("reads the liquidity changes of several v4 pools in one request, and of a single pool on its own", async () => {
    const { reader, asked } = chain();
    await marketCap(reader, CASHCAT, fresh(), NOW, { block: CUTOFF });
    expect(asked.filter(({ event }) => event === "ModifyLiquidity").map(({ from, to, named }) => [from, to, named])).toEqual([[21_389_814n, CUTOFF, 3]]);
    expect(asked.filter(({ event }) => event === "Mint" || event === "Burn").map(({ from, named }) => [from, named])).toEqual([[21_397_457n, 1], [21_397_457n, 1]]);
    const alone = chain({ swaps: SWAPS.filter(({ key }) => key !== SECOND && key !== EMPTY) });
    await marketCap(alone.reader, CASHCAT, fresh(), NOW, { block: CUTOFF });
    expect(alone.asked.filter(({ event }) => event === "ModifyLiquidity").map(({ from, named }) => [from, named])).toEqual([[21_400_710n, 1]]);
  });

  it("uses the deepest pool paired with ETH when no pool paired with USDG traded, priced through ETH's own deepest USDG pool", async () => {
    const swaps = SWAPS.filter(({ key }) => key === ETH_POOL || key === V3_ETH_USDG);
    const board = await marketCap(chain({ swaps }).reader, CASHCAT, fresh(), NOW, { block: CUTOFF });
    expect(board).toMatchObject({
      priceUsd: "0.04",
      marketCapUsd: "40000000.00",
      swap: { block: 21_400_000, transaction: hash("02") },
      pool: { version: "Uniswap v4", id: ETH_POOL, pair: "CASHCAT/ETH", pairedWith: "ETH", liquidityUsd: "536656.31", thin: false },
      ethUsd: { priceUsd: "2000", swap: { block: 21_401_000, transaction: hash("00") }, pool: { version: "Uniswap v3", address: V3_ETH_USDG, pair: "WETH/USDG", pairedWith: USDG, fee: 500, thin: false } },
    });
    expect(board.chosen).toBe(
      "No pool paired with USDG traded there. The only pool paired with ETH or WETH that traded in the 301,124 blocks up to block 21401123, priced in dollars through ETH's deepest pool paired with USDG at the same block.",
    );
  });

  it("looks further back a chunk at a time when nothing traded recently, and stops at the first chunk with a trade", async () => {
    const { reader, asked } = chain();
    const block = 22_400_710n;
    const board = await marketCap(reader, CASHCAT, fresh(), NOW, { block });
    expect(board.chosen).toBe("The only pool paired with USDG that traded in blocks 21400000 to 21499999, the latest trades in the 1,000,711 blocks up to block 22400710; 1 pool paired with ETH or WETH also traded there.");
    expect(board.pool).toMatchObject({ id: DEEP });
    // The price stands as the last swap left it, even though nothing traded for a million blocks.
    expect(board).toMatchObject({ priceUsd: "0.038251409", swap: { block: 21_400_710 } });
    const chunks = asked.filter(({ event }) => event === "Swap").map(({ from }) => from);
    expect(Math.min(...chunks.map(Number))).toBe(21_400_000);
    expect(asked.every(({ named, from, to }) => named <= 1 || to - from < CHUNK_BLOCKS)).toBe(true);
  });

  it("says so when no pool traded within the look-back, and when the token had not been traded by then", async () => {
    const tooLate = 21_401_000n + LOOKBACK_BLOCKS + RECENT_BLOCKS;
    await expect(marketCap(chain().reader, CASHCAT, fresh(), NOW, { block: tooLate })).rejects.toThrow(
      new ChainError(`No pool on Uniswap v3 or v4 that pairs ${CASHCAT} with USDG, ETH or WETH traded in the 3,000,000 blocks up to block ${tooLate}, so there is no price for it there.`),
    );
    const late = cashCat({ transfers: cashCat().transfers.map((transfer) => ({ ...transfer, block: transfer.block + 40_000_000n })) });
    await expect(marketCap(chain({ tokens: { [CASHCAT]: late } }).reader, CASHCAT, fresh(), NOW, { block: CUTOFF })).rejects.toThrow(
      new ChainError(`The contract at ${CASHCAT} had logged no transfers by block ${CUTOFF}, so nobody had traded it.`),
    );
  });

  it("gives a price and no past supply for a token whose supply does not follow its Transfer logs", async () => {
    const rebasing = cashCat({ supply: 1_100_000_000n * TOKENS });
    const board = await marketCap(chain({ tokens: { [CASHCAT]: rebasing } }).reader, CASHCAT, fresh(), NOW, { block: CUTOFF });
    expect(board.priceUsd).toBe("0.038251409");
    expect(board).not.toHaveProperty("supply");
    expect(board).not.toHaveProperty("marketCapUsd");
    expect(board.supplyCheck).toEqual({ block: Number(NEWEST), passed: false, transfers: "1000000000", totalSupply: "1100000000" });
  });

  it("reads the newest block without a cut-off, with the token's own totalSupply", async () => {
    const { reader, asked } = chain({ newest: CUTOFF });
    const board = await marketCap(reader, CASHCAT, fresh(), NOW);
    expect(board).toMatchObject({ asOf: { block: Number(CUTOFF), at: at(CUTOFF) }, supply: "1000000000", marketCapUsd: "38251409.44" });
    expect(board).not.toHaveProperty("supplyCheck");
    // Nothing reads the mints and burns: the supply is the contract's own.
    expect(asked.filter(({ event }) => event === "Transfer")).toHaveLength(1);
  });

  it("asks for at most 900 pools in a request, so a token with thousands of pools stays within what the endpoint takes", async () => {
    const spam: Created[] = Array.from({ length: 2_000 }, (_, i) => ({ version: 4, key: `0x${(i + 1).toString(16).padStart(64, "0")}` as Hash, currency0: CASHCAT, currency1: USDG, fee: 10_000 + i, block: 20_000_000n }));
    const { reader, asked } = chain({ pools: [...POOLS, ...spam] });
    const board = await marketCap(reader, CASHCAT, fresh(), NOW, { block: CUTOFF });
    expect(board.pool).toMatchObject({ id: DEEP });
    const v4 = asked.filter(({ event, named }) => event === "Swap" && named > 1);
    expect(Math.max(...v4.map(({ named }) => named))).toBe(POOLS_PER_REQUEST);
    expect(new Set(v4.map(({ named }) => named))).toEqual(new Set([POOLS_PER_REQUEST, 2_004 - 2 * POOLS_PER_REQUEST]));
  });

  it("keeps what has settled, so asking again reads only what it must", async () => {
    const { reader, asked } = chain();
    const kept = fresh();
    const first = await marketCap(reader, CASHCAT, kept, NOW, { block: CUTOFF });
    const reads = asked.length;
    const again = await marketCap(reader, CASHCAT, kept, NOW, { block: CUTOFF });
    expect(again).toEqual(first);
    // Only the mints and burns in the stretch that holds the newest block are read again, for the check against totalSupply.
    expect(asked.slice(reads).map(({ event, from }) => `${event} ${from}`)).toEqual(["Transfer 110000000", "Transfer 110000000"]);
  });

  it("refuses USDG itself and an address with no contract", async () => {
    await expect(marketCap(chain().reader, USDG, fresh(), NOW)).rejects.toThrow(new ChainError("USDG is the dollar this tool prices in: it counts one USDG as one dollar."));
    await expect(marketCap(chain().reader, OTHER, fresh(), NOW)).rejects.toThrow(/^There is no contract at 0xB97e4298c7F5f55360d207a6196125376675B3eA on Robinhood Chain\./);
  });
});
