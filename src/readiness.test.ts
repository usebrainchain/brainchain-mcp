import { readFileSync } from "node:fs";

import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, zeroAddress, type Address, type Hash, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";

import { ChainError, STILL_READING, type ChainHistory } from "./history.js";
import { MULTICALL3 } from "./premiums.js";
import { READINESS_NAME, READINESS_TOOL, tokenReadiness, UNISWAP_V3, UNISWAP_V4, type ReadinessKept } from "./readiness.js";

const CASHCAT = getAddress("0x020bfc650a365f8bb26819deaabf3e21291018b4");
const WETH = getAddress("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
const USDG = getAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
const LAUNCHER = getAddress("0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb");
const NEWEST = 115_822_898n;
const NOW = new Date("2026-11-16T21:00:00Z");
const hash = (byte: string) => `0x${byte.repeat(32)}` as Hash;
const nothingKept = (): ReadinessKept => ({ mints: new Map(), pools: new Map() });

const tokenAbi = parseAbi(["function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)", "function name() view returns (string)", "function symbol() view returns (string)"]);

interface Opened {
  venue: "v4" | "v3";
  block: bigint;
  index?: number;
  /** The pair in address order, as the pool names it. */
  pair: [Address, Address];
  transaction: Hash;
}

interface Token {
  decimals?: number;
  supply?: bigint;
  name?: string;
  symbol?: string;
  /** The block of the first mint. */
  minted?: bigint;
  /** The block of an earlier mint of nothing, which some tokens log when they are set up. */
  mintedNothing?: bigint;
}

// Read from Robinhood Chain on 2026-11-16: Cash Cat's first mint and its first pool on each venue.
const MINT = { block: 88_836n, at: "2026-06-18T20:01:25.000Z", transaction: hash("0e") };
const V3_POOL: Opened = { venue: "v3", block: 88_836n, index: 4, pair: [CASHCAT, WETH], transaction: MINT.transaction };
const V4_POOL: Opened = { venue: "v4", block: 820_611n, pair: [zeroAddress, CASHCAT], transaction: hash("a4") };
const TIMES: Record<string, string> = { "88836": MINT.at, "820611": "2026-07-01T19:07:10.000Z" };

/** Robinhood Chain as `tokenReadiness` meets it: one token, the pools opened for it, and the newest block. */
function chain(token: Token | undefined, pools: Opened[] = [], { newest = NEWEST } = {}) {
  const asked: string[] = [];
  const failing: { logs?: Error } = {};
  const reader = {
    async readContract({ address, args }: { address: Address; args: [{ target: Address; callData: Hex }[]] }) {
      asked.push("aggregate3");
      expect(address).toBe(MULTICALL3);
      return args[0].map(({ callData }) => {
        const call = decodeFunctionData({ abi: tokenAbi, data: callData });
        if (!token) return { success: true, returnData: "0x" as Hex };
        const value = { decimals: token.decimals, totalSupply: token.supply, name: token.name, symbol: token.symbol }[call.functionName];
        return value === undefined ? { success: false, returnData: "0x" as Hex } : { success: true, returnData: encodeFunctionResult({ abi: tokenAbi, functionName: call.functionName, result: value as never }) };
      });
    },
    async getBlockNumber() {
      asked.push("newest");
      return newest;
    },
    async getCode() {
      asked.push("code");
      return token ? "0x6080" : undefined;
    },
    async getLogs({ address, event, args, fromBlock, toBlock }: { address: Address; event: { name: string }; args: Record<string, Address>; fromBlock: bigint; toBlock: bigint }) {
      if (failing.logs) throw failing.logs;
      const inside = (block: bigint) => block >= fromBlock && block <= toBlock;
      if (event.name === "Transfer") {
        asked.push(`mint ${fromBlock}-${toBlock}`);
        expect([address, args.from]).toEqual([CASHCAT, zeroAddress]);
        const mint = (block: bigint | undefined, value: bigint) => (block !== undefined && inside(block) ? [{ blockNumber: block, logIndex: 1, transactionHash: MINT.transaction, args: { from: zeroAddress, to: LAUNCHER, value } }] : []);
        return [...mint(token?.mintedNothing, 0n), ...mint(token?.minted, 10n ** 27n)];
      }
      const venue = event.name === "Initialize" ? "v4" : "v3";
      expect(address).toBe(venue === "v4" ? UNISWAP_V4 : UNISWAP_V3);
      const [key] = Object.keys(args);
      const side = key === "currency0" || key === "token0" ? 0 : 1;
      asked.push(`${venue} side ${side} ${fromBlock}-${toBlock}`);
      return pools
        .filter((pool) => pool.venue === venue && pool.pair[side] === args[key!] && inside(pool.block))
        .map((pool) => ({
          blockNumber: pool.block,
          logIndex: pool.index ?? 0,
          transactionHash: pool.transaction,
          args: venue === "v4" ? { currency0: pool.pair[0], currency1: pool.pair[1] } : { token0: pool.pair[0], token1: pool.pair[1] },
        }));
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      asked.push(`block ${blockNumber}`);
      return { timestamp: BigInt(Date.parse(TIMES[String(blockNumber)] ?? "2026-09-01T00:00:00Z") / 1000) };
    },
  } as unknown as ChainHistory;
  return { reader, asked, failing, poolsAsked: () => asked.filter((entry) => entry.startsWith("v4 ") || entry.startsWith("v3 ")) };
}

const cashCat = (more: Token = {}): Token => ({ decimals: 18, supply: 10n ** 27n, name: "Cash Cat", symbol: "CASHCAT", minted: MINT.block, ...more });

describe("the readiness tool's words", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const row = readme.split("\n").find((line) => line.startsWith(`| \`${READINESS_NAME}\` |`))!;
  const paragraph = readme.split("\n").find((line) => line.startsWith(`\`${READINESS_NAME}\` reads `))!;

  it("say what a pool does and does not show, in the description and in the README", () => {
    for (const text of [READINESS_TOOL.description!, paragraph]) {
      expect(text).toContain("A token is often named before it exists: BitGo's public code lists contracts that are not deployed yet.");
      expect(text).toContain("Only the first pool on each venue is listed. Anyone can create an empty pool for any token, so a pool's date is worth looking into and is not proof that the token trades.");
      expect(text).toContain("Each `at` is the time of the block that holds the event, so a backtest sees each step when it happened.");
      expect(text).not.toMatch(/guarantee|will be listed|insider/i);
    }
    expect(READINESS_TOOL.description).toMatch(/Free, no key and no payment\. Not advice\.$/);
  });

  it("name the answer's fields as the answer does", () => {
    const fields = ["`token`", "`deployed`", "`name`", "`symbol`", "`decimals`", "`totalSupply`", "`firstMint`", "`at`", "`block`", "`transaction`", "`to`", "`pools`", "`venue`", "`pairedWith`", "`readAt`"];
    for (const text of [READINESS_TOOL.description!, row]) for (const field of fields) expect(text).toContain(field);
  });

  it("are counted with the tools that only read, and ask for the token alone", () => {
    expect(READINESS_TOOL.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(READINESS_TOOL.inputSchema).toMatchObject({ required: ["token"], additionalProperties: false });
    expect(Object.keys(READINESS_TOOL.inputSchema.properties!)).toEqual(["token"]);
    expect(readme).toContain(`- \`${READINESS_NAME}\` `);
  });
});

describe("tokenReadiness", () => {
  it("says a token is not deployed when no contract is at the address, and reads nothing more", async () => {
    const { reader, asked } = chain(undefined);
    expect(await tokenReadiness(reader, CASHCAT, nothingKept(), NOW)).toEqual({ chain: "Robinhood Chain", token: { contract: CASHCAT }, readAt: "2026-11-16T21:00:00.000Z", deployed: false });
    expect(asked).toEqual(["aggregate3", "code"]);
  });

  it("gives a deployed token's first mint and its first pool on each venue, earliest first", async () => {
    const { reader } = chain(cashCat(), [V4_POOL, V3_POOL]);
    expect(await tokenReadiness(reader, CASHCAT, nothingKept(), NOW)).toEqual({
      chain: "Robinhood Chain",
      token: { contract: CASHCAT, name: "Cash Cat", symbol: "CASHCAT", decimals: 18, totalSupply: "1000000000" },
      readAt: "2026-11-16T21:00:00.000Z",
      deployed: true,
      firstMint: { at: MINT.at, block: 88_836, transaction: MINT.transaction, to: LAUNCHER },
      pools: [
        { venue: "Uniswap v3", at: MINT.at, block: 88_836, transaction: MINT.transaction, pairedWith: WETH },
        { venue: "Uniswap v4", at: "2026-07-01T19:07:10.000Z", block: 820_611, transaction: V4_POOL.transaction, pairedWith: "ETH" },
      ],
    });
  });

  it("finds the token on either side of a pair and keeps the earlier pool of a venue, whichever side that is", async () => {
    // USDG sorts above Cash Cat and ETH below it, so the token is first in one pair and second in the other.
    for (const [withEth, withUsdg, first] of [
      [820_611n, 9_000_000n, "ETH"],
      [9_000_000n, 820_611n, USDG],
    ] as const) {
      const { reader } = chain(cashCat(), [
        { venue: "v4", block: withUsdg, pair: [CASHCAT, USDG], transaction: hash("b1") },
        { venue: "v4", block: withEth, pair: [zeroAddress, CASHCAT], transaction: hash("b2") },
      ]);
      expect((await tokenReadiness(reader, CASHCAT, nothingKept(), NOW)).pools).toEqual([expect.objectContaining({ venue: "Uniswap v4", block: 820_611, pairedWith: first })]);
    }
  });

  it("lists the venues earliest first, and orders two pools of one block by their place in it", async () => {
    // The v4 pool is found before the v3 one, since v4 is looked at first, and it is the later of the two.
    const late = chain(cashCat(), [{ venue: "v4", block: 9_000_000n, pair: [CASHCAT, USDG], transaction: hash("b1") }, V3_POOL]);
    expect((await tokenReadiness(late.reader, CASHCAT, nothingKept(), NOW)).pools!.map(({ venue }) => venue)).toEqual(["Uniswap v3", "Uniswap v4"]);

    const sameBlock = chain(cashCat(), [
      { venue: "v3", block: 500_000n, index: 4, pair: [CASHCAT, WETH], transaction: hash("c4") },
      { venue: "v4", block: 500_000n, index: 2, pair: [zeroAddress, CASHCAT], transaction: hash("c2") },
      { venue: "v4", block: 500_000n, index: 7, pair: [CASHCAT, USDG], transaction: hash("c7") },
    ]);
    expect((await tokenReadiness(sameBlock.reader, CASHCAT, nothingKept(), NOW)).pools!.map(({ venue, pairedWith }) => [venue, pairedWith])).toEqual([
      ["Uniswap v4", "ETH"],
      ["Uniswap v3", WETH],
    ]);
  });

  it("lists a pool created in the days before the first mint", async () => {
    const before: Opened = { venue: "v3", block: 40_000n, pair: [CASHCAT, WETH], transaction: hash("c0") };
    const { reader } = chain(cashCat(), [before, V3_POOL]);
    expect((await tokenReadiness(reader, CASHCAT, nothingKept(), NOW)).pools).toEqual([expect.objectContaining({ venue: "Uniswap v3", block: 40_000, transaction: hash("c0") })]);
  });

  it("takes the first mint of something, not an earlier mint of nothing", async () => {
    const { reader } = chain(cashCat({ mintedNothing: 12n }));
    expect((await tokenReadiness(reader, CASHCAT, nothingKept(), NOW)).firstMint).toMatchObject({ block: 88_836 });
  });

  it("looks for pools from the beginning for a token that has supply and no mint on record", async () => {
    const { reader, poolsAsked } = chain(cashCat({ minted: undefined }), [V4_POOL]);
    const board = await tokenReadiness(reader, CASHCAT, nothingKept(), NOW);
    expect(board).not.toHaveProperty("firstMint");
    expect(board.pools).toEqual([expect.objectContaining({ venue: "Uniswap v4", block: 820_611 })]);
    expect(poolsAsked()[0]).toBe("v4 side 0 0-9999999");
  });

  it("gives a token with nothing minted no first mint and no pools, and looks for none", async () => {
    const { reader, asked, poolsAsked } = chain(cashCat({ minted: undefined, supply: 0n }), [V4_POOL]);
    const board = await tokenReadiness(reader, CASHCAT, nothingKept(), NOW);
    expect(board).toMatchObject({ deployed: true, pools: [] });
    expect(board).not.toHaveProperty("firstMint");
    expect(poolsAsked()).toEqual([]);
    expect(asked.filter((entry) => entry.startsWith("mint "))).toHaveLength(12);
  });

  it("looks for pools from the stretch of the first mint on, and reads each venue and side until it finds a pool", async () => {
    const { reader, poolsAsked } = chain(cashCat({ minted: 60_198_107n }), [{ venue: "v4", block: 61_004_113n, pair: [zeroAddress, CASHCAT], transaction: hash("d3") }]);
    await tokenReadiness(reader, CASHCAT, nothingKept(), NOW);
    const asked = poolsAsked();
    expect(asked.filter((entry) => entry.startsWith("v4 side 1"))).toEqual(["v4 side 1 60000000-69999999"]);
    for (const search of ["v4 side 0", "v3 side 0", "v3 side 1"]) {
      expect(asked.filter((entry) => entry.startsWith(search))).toEqual([60, 70, 80, 90, 100].map((m) => `${search} ${m}000000-${m + 9}999999`).concat(`${search} 110000000-${NEWEST}`));
    }
  });

  it("keeps what has settled, so asking again reads only the token and the newest block", async () => {
    const kept = nothingKept();
    const { reader, asked } = chain(cashCat(), [V4_POOL, V3_POOL]);
    const first = await tokenReadiness(reader, CASHCAT, kept, NOW);
    asked.length = 0;
    expect(await tokenReadiness(reader, CASHCAT, kept, NOW)).toEqual(first);
    // A venue and side with no pool is read again only in the stretch that can still change.
    expect(asked).toEqual(["aggregate3", "newest", `v4 side 0 110000000-${NEWEST}`, `v3 side 1 110000000-${NEWEST}`]);
  });

  it("says so when the contract does not behave like a token", async () => {
    const { reader } = chain(cashCat({ decimals: undefined }));
    await expect(tokenReadiness(reader, CASHCAT, nothingKept(), NOW)).rejects.toStrictEqual(
      new ChainError(`The contract at ${CASHCAT} on Robinhood Chain does not behave like a token: its decimals, its total supply or a balance could not be read. Check that this is the token's own contract address.`),
    );
  });

  it("passes on a read the endpoint refused, and keeps nothing of it", async () => {
    const kept = nothingKept();
    const { reader, failing } = chain(cashCat(), [V4_POOL]);
    failing.logs = Object.assign(new Error("HTTP request failed."), { status: 429 });
    await expect(tokenReadiness(reader, CASHCAT, kept, NOW)).rejects.toBe(failing.logs);
    await Promise.resolve();
    expect(kept.mints.size + kept.pools.size).toBe(0);
  });
});

describe("readTokenReadiness", () => {
  it("says after 45 seconds that it is still reading", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    try {
      const fresh = await import("./readiness.js");
      const history = await import("./history.js");
      const late = expect(fresh.readTokenReadiness(CASHCAT)).rejects.toStrictEqual(new history.ChainError(history.STILL_READING));
      await vi.advanceTimersByTimeAsync(44_999);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(1);
      await late;
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
