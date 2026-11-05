import { describe, expect, it } from "vitest";

import { MANDATE, stockPremiums, usMarketOpen, type ChainReader } from "./premiums.js";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const POOL = "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3";
const FEED = "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

// Read from Robinhood Chain on 2026-11-04: USDG is token0 in the NVDA pool.
const reader = {
  async readContract({ functionName }: { functionName: string }) {
    if (functionName === "tokenCount") return 2n;
    throw new Error(functionName);
  },
  async multicall({ contracts }: { contracts: { address: string; functionName: string; args?: unknown[] }[] }) {
    return contracts.map(({ address, functionName, args }) => {
      if (address === MANDATE && functionName === "tokens") return args?.[0] === 0n ? NVDA : "0x0000000000000000000000000000000000000001";
      if (address === MANDATE && functionName === "venues") return args?.[0] === NVDA ? [POOL, FEED, true] : [POOL, FEED, false];
      if (functionName === "symbol") return "NVDA";
      if (functionName === "uiMultiplier") return 1000775159164630595n;
      if (functionName === "token0") return USDG;
      if (functionName === "slot0") return [5594113873511672267928782461116692n, 223309, 0, 0, 0, 0, true];
      if (functionName === "latestRoundData") return [1n, 20041773531n, 0n, 1793825722n, 1n];
      throw new Error(functionName);
    });
  },
} as unknown as ChainReader;

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
