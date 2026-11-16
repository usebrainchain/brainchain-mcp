import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MANDATE, PREMIUMS_NAME, PREMIUMS_TOOL, stockPremiums, usMarketOpen, type ChainReader } from "./premiums.js";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const POOL = "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3";
const FEED = "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

const SPY = "0x00000000000000000000000000000000000000a2";
const SPY_POOL = "0x00000000000000000000000000000000000000b2";
const SPY_FEED = "0x00000000000000000000000000000000000000c2";

interface Venue {
  token: string;
  pool: string;
  feed: string;
  live: boolean;
  symbol: string;
  multiplier: bigint;
  token0: string;
  sqrtPriceX96: bigint;
  answer: bigint;
}

// Read from Robinhood Chain on 2026-11-04: USDG is token0 in the NVDA pool.
const nvda: Venue = { token: NVDA, pool: POOL, feed: FEED, live: true, symbol: "NVDA", multiplier: 1000775159164630595n, token0: USDG, sqrtPriceX96: 5594113873511672267928782461116692n, answer: 20041773531n };
const dead: Venue = { ...nvda, token: "0x0000000000000000000000000000000000000001", live: false };
// The stock is token0, and 2^80 prices it at 1e18 >> 32 units: 232.830643 USDG a token.
const spy: Venue = { token: SPY, pool: SPY_POOL, feed: SPY_FEED, live: true, symbol: "SPY", multiplier: 10n ** 18n, token0: SPY, sqrtPriceX96: 2n ** 80n, answer: 23283064300n };

/** The mandate lists `venues`; a read named in `failing` reverts, as a multicall with allowFailure reports it. */
function readerOf(venues: Venue[], failing: { address: string; functionName: string }[] = []): ChainReader {
  const reads = (address: string, functionName: string, args?: unknown[]): unknown => {
    if (address === MANDATE && functionName === "tokens") return venues[Number(args?.[0])]!.token;
    if (address === MANDATE && functionName === "venues") {
      const v = venues.find((venue) => venue.token === args?.[0])!;
      return [v.pool, v.feed, v.live];
    }
    const v = venues.find((venue) => [venue.token, venue.pool, venue.feed].includes(address))!;
    if (functionName === "symbol") return v.symbol;
    if (functionName === "uiMultiplier") return v.multiplier;
    if (functionName === "token0") return v.token0;
    if (functionName === "slot0") return [v.sqrtPriceX96, 223309, 0, 0, 0, 0, true];
    if (functionName === "latestRoundData") return [1n, v.answer, 0n, 1793825722n, 1n];
    throw new Error(functionName);
  };
  return {
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "tokenCount") return BigInt(venues.length);
      throw new Error(functionName);
    },
    async multicall({ contracts, allowFailure }: { contracts: { address: string; functionName: string; args?: unknown[] }[]; allowFailure: boolean }) {
      return contracts.map(({ address, functionName, args }) => {
        const reverts = failing.some((f) => f.address === address && f.functionName === functionName);
        if (!allowFailure) {
          if (reverts) throw new Error(`${functionName} reverted`);
          return reads(address, functionName, args);
        }
        return reverts ? { status: "failure", error: new Error(`${functionName} reverted`) } : { status: "success", result: reads(address, functionName, args) };
      });
    },
  } as unknown as ChainReader;
}

const reader = readerOf([nvda, dead]);

describe("the premium tool's words", () => {
  it("say what happens over a weekend, and claim nothing about when tokens are minted", () => {
    expect(PREMIUMS_TOOL.description).toContain("Over a weekend the feeds stand still and the pools keep trading.");
    const row = readFileSync(new URL("../README.md", import.meta.url), "utf8").split("\n").find((line) => line.startsWith(`| \`${PREMIUMS_NAME}\` |`))!;
    for (const text of [PREMIUMS_TOOL.description!, row]) expect(text).not.toMatch(/minted|clears on its own/);
  });

  it("promise each stock on the list rather than a fixed set of tickers", () => {
    const row = readFileSync(new URL("../README.md", import.meta.url), "utf8").split("\n").find((line) => line.startsWith(`| \`${PREMIUMS_NAME}\` |`))!;
    for (const text of [PREMIUMS_TOOL.description!, row]) expect(text).toContain("for each stock on BrainChain's list (today NVDA,");
  });
});

describe("stockPremiums", () => {
  it("prices the live venues from the pool and the feed, per whole token", async () => {
    const board = await stockPremiums(reader, new Date("2026-11-04T21:20:00Z"));
    expect(board.usMarketOpen).toBe(false);
    expect(board.stocks).toHaveLength(1);
    const [nvda] = board.stocks;
    expect(nvda).toMatchObject({ symbol: "NVDA", token: NVDA, pool: POOL, chainlinkPrice: "200.57", feedUpdatedAt: "2026-11-04T20:55:22.000Z" });
    expect(nvda!.poolPrice).toMatch(/^200\.5\d$/);
    expect(nvda!.premiumPct).toMatch(/^[+-]0\.0\d$/);
    expect(nvda!.feedAgeSeconds).toBe(1478);
  });

  it("prices every other stock when one stock's token, pool or feed reverts, and says which could not be priced", async () => {
    for (const failing of [{ address: SPY, functionName: "symbol" }, { address: SPY_POOL, functionName: "slot0" }, { address: SPY_FEED, functionName: "latestRoundData" }]) {
      const board = await stockPremiums(readerOf([nvda, spy], [failing]), new Date("2026-11-04T21:20:00Z"));
      expect(board.stocks.map((s) => s.symbol)).toEqual(["NVDA"]);
      expect(board.unpriced).toEqual([
        { ...(failing.functionName === "symbol" ? {} : { symbol: "SPY" }), token: SPY, pool: SPY_POOL, reason: "Its token, pool or feed could not be read just now." },
      ]);
    }
    expect(await stockPremiums(readerOf([nvda, spy]), new Date("2026-11-04T21:20:00Z"))).not.toHaveProperty("unpriced");
  });

  it("does not price a pool with no price yet or a feed that reports none", async () => {
    for (const [change, reason] of [
      [{ token0: USDG, sqrtPriceX96: 0n }, "Its pool has no price yet."],
      [{ answer: 0n }, "Its Chainlink feed reports no price."],
      [{ answer: -1n }, "Its Chainlink feed reports no price."],
    ] as const) {
      const board = await stockPremiums(readerOf([nvda, { ...spy, ...change }]), new Date("2026-11-04T21:20:00Z"));
      expect(board.stocks.map((s) => s.symbol)).toEqual(["NVDA"]);
      expect(board.unpriced).toEqual([{ symbol: "SPY", token: SPY, pool: SPY_POOL, reason }]);
    }
  });

  it("signs the premium as rounded, so one that rounds to nothing reads +0.00", async () => {
    // Against 232.830643 in the pool: 0.006 above it is -0.0026%, 0.0233 above it -0.01%, 2.3283 below it +1.01%.
    for (const [answer, premiumPct] of [
      [23283664300n, "+0.00"],
      [23285394300n, "-0.01"],
      [23050234300n, "+1.01"],
      [spy.answer, "+0.00"],
    ] as const) {
      const [stock] = (await stockPremiums(readerOf([{ ...spy, answer }]), new Date("2026-11-04T21:20:00Z"))).stocks;
      expect(stock).toMatchObject({ poolPrice: "232.83", premiumPct });
    }
  });

  it("knows the regular session in New York time, winter and summer", () => {
    expect(usMarketOpen(new Date("2026-11-04T14:29:00Z"))).toBe(false);
    expect(usMarketOpen(new Date("2026-11-04T14:30:00Z"))).toBe(true);
    expect(usMarketOpen(new Date("2026-11-04T20:59:00Z"))).toBe(true);
    expect(usMarketOpen(new Date("2026-11-04T21:00:00Z"))).toBe(false);
    expect(usMarketOpen(new Date("2026-07-01T13:29:00Z"))).toBe(false);
    expect(usMarketOpen(new Date("2026-07-01T13:30:00Z"))).toBe(true);
    expect(usMarketOpen(new Date("2026-07-01T19:59:00Z"))).toBe(true);
    expect(usMarketOpen(new Date("2026-07-01T20:00:00Z"))).toBe(false);
    expect(usMarketOpen(new Date("2026-11-07T16:00:00Z"))).toBe(false);
  });
});
