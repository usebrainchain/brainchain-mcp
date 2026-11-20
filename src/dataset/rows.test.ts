import { getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";

import type { WatchEvent } from "../watch/events.js";
import { attribute, folded, outcomesFromEvents, stepsFromEvents, tracedIn } from "./rows.js";
import { TokenTable } from "./table.js";

const CASHCAT = getAddress("0x020bfc650a365f8bb26819deaabf3e21291018b4");
const DOGEISH = getAddress("0xb66d83f0a5a3b5ee6f4c1c1c11f1ae10b2b71a31");
const PONS = getAddress("0x39dbed3a00000000000000000000000000000000");
const BASELINE = "2026-11-19T09:20:49.454Z";
let id = 0;
const event = (kind: WatchEvent["kind"], token: Partial<WatchEvent["token"]>, extra: Partial<WatchEvent> = {}): WatchEvent => ({
  id: ++id,
  kind,
  token: { address: null, symbol: null, name: null, ...token },
  source: "x",
  ref: "https://example.com/ref",
  at: null,
  observedAt: BASELINE,
  detail: {},
  context: {},
  baseline: true,
  ...extra,
});

describe("the steps in the watcher's log", () => {
  it("dates each step by its source, by `by` when it was there at the start, and by when it was seen otherwise", () => {
    const events = [
      event("bitgo.merged", { address: CASHCAT, name: "Cash Cat" }, { at: "2026-07-28T07:09:00.000Z", detail: { id: "hoodeth:cashcat" } }),
      event("metamask.merged", { address: CASHCAT }, { detail: { link: "https://github.com/MetaMask/x.json" } }),
      event("trustwallet.merged", { address: PONS }),
      event("coingecko.listed", { address: CASHCAT }),
      event("lifi.listed", { address: PONS }, { baseline: undefined, observedAt: "2026-11-20T10:00:00.000Z" }),
      event("bitgo.pr_opened", { address: PONS }, { baseline: undefined, at: "2026-11-20T11:00:00.000Z", observedAt: "2026-11-20T11:00:20.000Z" }),
      event("bitgo.released", { address: CASHCAT }, { detail: { version: "59.0.0", by: "2026-08-01T00:00:00.000Z" } }),
      event("lifi.listed", { address: zeroAddress, symbol: "ETH" }),
    ];
    const rows = stepsFromEvents(events, new Map([[`MetaMask|${CASHCAT.toLowerCase()}`, "2026-07-08T17:24:52.000Z"]]));
    expect(rows).toEqual([
      { token: CASHCAT, step: "custody", source: "BitGo", at: "2026-07-28T07:09:00.000Z", atFrom: "push", ref: "https://example.com/ref", id: "hoodeth:cashcat", observedAt: BASELINE, backfill: true },
      { token: CASHCAT, step: "listing", source: "MetaMask", at: "2026-07-08T17:24:52.000Z", atFrom: "push", ref: "https://github.com/MetaMask/x.json", observedAt: BASELINE, backfill: true },
      { token: PONS, step: "listing", source: "Trust Wallet", by: BASELINE, ref: "https://example.com/ref", observedAt: BASELINE, backfill: true },
      { token: CASHCAT, step: "aggregator", source: "CoinGecko", by: BASELINE, ref: "https://example.com/ref", observedAt: BASELINE, backfill: true },
      { token: PONS, step: "aggregator", source: "LI.FI", at: "2026-11-20T10:00:00.000Z", atFrom: "observed", ref: "https://example.com/ref", observedAt: "2026-11-20T10:00:00.000Z" },
      { token: PONS, step: "custody_pr", source: "BitGo", at: "2026-11-20T11:00:00.000Z", atFrom: "source", ref: "https://example.com/ref", observedAt: "2026-11-20T11:00:20.000Z" },
      { token: CASHCAT, step: "custody_release", source: "BitGo", by: "2026-08-01T00:00:00.000Z", ref: "https://example.com/ref", version: "59.0.0", observedAt: BASELINE, backfill: true },
    ]);
  });

  it("traces every token a source names by contract, but not ETH and not one known only from a new pool", () => {
    const traced = tracedIn([event("lifi.listed", { address: zeroAddress }), event("pool.created", { address: PONS }), event("kucoin.listed", { address: CASHCAT, symbol: "cashcat", name: "Cash Cat" })]);
    expect([...traced.keys()]).toEqual([CASHCAT.toLowerCase()]);
    expect(traced.get(CASHCAT.toLowerCase())).toMatchObject({ symbols: new Set(["CASHCAT"]), names: new Set(["Cash Cat"]), baseline: true });
  });
});

describe("the outcomes", () => {
  const traced = tracedIn([
    event("coingecko.listed", { address: CASHCAT, symbol: "CASHCAT", name: "Cash Cat" }),
    event("coingecko.listed", { address: DOGEISH, symbol: "DOGE", name: "DoOnlyGoodEveryday" }),
    event("lifi.listed", { address: PONS, symbol: "PONS", name: "Pons" }),
  ]);

  it("ties a symbol to a token by the venue's name for it, or by the symbol alone when one token has it and no venue names it otherwise", () => {
    const pairs = new Map([["DOGE", "Dogecoin"]]);
    expect(attribute("cashcat", "Cash Cat", traced, pairs)).toEqual({ token: CASHCAT, match: "name" });
    expect(attribute("DOGE", undefined, traced, pairs)).toBeUndefined();
    expect(attribute("DOGE", "Dogecoin", traced, pairs)).toBeUndefined();
    expect(attribute("PONS", undefined, traced, pairs)).toEqual({ token: PONS, match: "symbol" });
    expect(attribute("WOJAK", undefined, traced, pairs)).toBeUndefined();
    expect(folded("Cash-Cat ")).toBe(folded("CASH CAT"));
  });

  it("dates KuCoin and Gate by the trading start they publish, and Robinhood by when the watcher first saw it", () => {
    const events = [
      event("kucoin.listed", { address: CASHCAT, symbol: "CASHCAT", name: "Cash Cat" }, { ref: "https://api.kucoin.com/api/v3/currencies" }),
      event("gate.listed", { address: PONS, symbol: "PONS", name: "Pons" }, { baseline: undefined, observedAt: "2026-11-20T12:00:00.000Z" }),
      event("robinhood.pair_added", { symbol: "CASHCAT", name: "Cash Cat" }, { detail: { tradable: true } }),
      event("robinhood.pair_added", { symbol: "DOGE", name: "Dogecoin" }, { detail: { tradable: true } }),
      event("robinhood.page_added", { symbol: "DOGE" }),
      event("robinhood.page_added", { symbol: "PONS" }, { baseline: undefined, observedAt: "2026-11-20T13:00:00.000Z" }),
      event("robinhood.tradability_changed", { symbol: "CASHCAT", name: "Cash Cat" }, { baseline: undefined, observedAt: "2026-11-20T14:00:00.000Z", ref: "https://nummus.robinhood.com/currency_pairs/#CASHCAT@2026-11-20", detail: { tradable: true } }),
    ];
    const starts = { kucoin: new Map([["CASHCAT", Date.parse("2026-07-15T10:00:00Z")]]), gate: new Map([["PONS", Date.parse("2026-12-01T00:00:00Z")]]) };
    const rows = outcomesFromEvents(events, traced, starts);
    expect(rows.map(({ token, outcome, at, by, atFrom, match }) => ({ token, outcome, at, by, atFrom, match }))).toEqual([
      { token: CASHCAT, outcome: "kucoin", at: "2026-07-15T10:00:00.000Z", by: undefined, atFrom: "source", match: "contract" },
      // Gate's start is after the watcher saw the listing, so it is dated by the sighting.
      { token: PONS, outcome: "gate", at: "2026-11-20T12:00:00.000Z", by: undefined, atFrom: "observed", match: "contract" },
      { token: CASHCAT, outcome: "robinhood_tradable", at: undefined, by: BASELINE, atFrom: undefined, match: "name" },
      { token: PONS, outcome: "robinhood_page", at: "2026-11-20T13:00:00.000Z", by: undefined, atFrom: "observed", match: "symbol" },
      { token: CASHCAT, outcome: "robinhood_tradable", at: "2026-11-20T14:00:00.000Z", by: undefined, atFrom: "observed", match: "name" },
    ]);
    expect(rows[1]).toMatchObject({ tradingStart: "2026-12-01T00:00:00.000Z" });
    expect(rows[4]!.ref).toBe("https://nummus.robinhood.com/currency_pairs/#CASHCAT");
  });
});

describe("the token table", () => {
  it("keeps each token's first pool on each venue and its earliest block, and tells tokens that share a prefix apart", () => {
    const table = new TokenTable(16);
    const a = "0x1234567890abc000000000000000000000000001";
    const b = "0x1234567890abc000000000000000000000000002";
    expect(table.addPool(a, 2, 500)).toBe(true);
    expect(table.addPool(a, 2, 400)).toBe(false);
    expect(table.addPool(a.toUpperCase().replace("0X", "0x"), 1, 900)).toBe(true);
    expect(table.addPool(b, 1, 50)).toBe(true);
    for (let i = 0; i < 100; i++) table.addPool(`0x${(i + 7).toString(16).padStart(40, "0")}`, 1, 10_000 + i);
    expect(table.size).toBe(102);
    expect(table.get(a)).toBe(3);
    expect(table.markNamed(a)).toBe(true);
    expect(table.markNamed(a)).toBe(false);
    expect(table.markNamed("0x00000000000000000000000000000000000000ff")).toBe(false);
    expect(table.firstPools(1_000, 10_099)).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100]);
  });
});
