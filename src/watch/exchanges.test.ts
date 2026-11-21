import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventLog, type Found } from "./events.js";
import { BINANCE_FUTURES_MARKETS, BITGET_MARKETS, BITHUMB_MARKETS, CHAIN_START, marketPoller, matchAsset, universeFrom, universeOf, UPBIT_MARKETS, type VenueList } from "./exchanges.js";
import { Requests } from "./http.js";
import { StateFile } from "./state.js";
import { Watcher } from "./watcher.js";

const PONS = "0x39dBED3a2bd333467115dE45665cC57F813C4571";
const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const OTHER = "0x0000000000000000000000000000000000000B0b";
const SEP_6 = Date.parse("2026-09-06T06:45:00Z");

const known = (address: string, symbol: string, name: string): Found => ({ kind: "lifi.listed", token: { address, symbol, name }, source: "LI.FI", ref: "https://li.quest/v1/tokens?chains=4663", at: null, detail: {} });

function routes(table: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return table[String(input)]?.() ?? new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  return { requests: new Requests({ fetch: fetchImpl }), asked, table };
}

const json = (value: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(value), { headers });

/** A log that already knows Pons and Cash Cat from a list, and a runner for one market list. */
function harness(list: VenueList, table: Record<string, () => Response>, tokens: Found[] = [known(PONS, "PONS", "Pons"), known(CASHCAT, "CASHCAT", "Cash Cat")]) {
  const dir = mkdtempSync(join(tmpdir(), "brainchain-watch-"));
  const log = new EventLog(dir);
  log.append(tokens.map((token) => ({ ...token, baseline: true as const, observedAt: "2026-11-19T09:20:00.000Z" })));
  const { requests, asked } = routes(table);
  const poller = marketPoller(requests, list, universeFrom(log));
  const watcher = new Watcher({ log, state: new StateFile(dir), pollers: [poller], say: () => {} });
  const venue = () => log.all().filter(({ kind }) => kind.startsWith("venue."));
  return { log, asked, run: () => watcher.runOnce(poller), status: () => watcher.status.get(poller.name)!, venue, news: () => log.query().events.filter(({ kind }) => kind.startsWith("venue.")) };
}

const BITGET = "https://api.bitget.com/api/v2";
const SPOT = `${BITGET}/spot/public/symbols`;
const COINS = `${BITGET}/spot/public/coins`;
const PERPS = `${BITGET}/mix/market/contracts?productType=USDT-FUTURES`;
const ok = (data: unknown[]) => json({ code: "00000", data });
const pair = (base: string, status = "online", quote = "USDT") => ({ symbol: `${base}${quote}`, baseCoin: base, quoteCoin: quote, status, openTime: "" });
const perp = (base: string, more: Record<string, unknown> = {}) => ({ symbol: `${base}USDT`, baseCoin: base, quoteCoin: "USDT", symbolStatus: "normal", symbolType: "perpetual", isRwa: "NO", launchTime: "", openTime: "", ...more });
const coin = (name: string, chains: { chain: string; contractAddress: string }[]) => ({ coin: name, chains });
const bitget = (spot: unknown[], coins: unknown[], perps: unknown[] = []): Record<string, () => Response> => ({ [SPOT]: ok(spot), [COINS]: ok(coins), [PERPS]: ok(perps) });

describe("an exchange's market list", () => {
  it("reports a token's first market on the venue, matched by the contract the venue gives on Robinhood Chain, and nothing it had before", async () => {
    const coins = [coin("BTC", [{ chain: "BTC", contractAddress: "" }]), coin("PONS", [{ chain: "Robinhood", contractAddress: PONS.toLowerCase() }])];
    const table = bitget([pair("BTC")], coins);
    const { run, news, venue } = harness(BITGET_MARKETS, table);
    await run();
    expect(venue()).toEqual([]);
    table[SPOT] = ok([pair("BTC"), pair("PONS", "gray")]);
    await run();
    expect(news().map(({ kind, token, source, ref, at, detail }) => ({ kind, token, source, ref, at, detail }))).toEqual([
      {
        kind: "venue.listed",
        token: { address: PONS, symbol: "PONS", name: "Pons" },
        source: "Bitget",
        ref: `${SPOT}?symbol=PONSUSDT`,
        at: null,
        detail: { market: "PONSUSDT", type: "spot", quote: "USDT", status: "pre-trading", venueStatus: "gray", match: "contract" },
      },
    ]);
    // A second quote for the same asset is no new listing; the start of trading is a change of status.
    table[SPOT] = ok([pair("BTC"), pair("PONS"), pair("PONS", "gray", "USDC")]);
    await run();
    await run();
    expect(news().map(({ kind, detail }) => [kind, detail.status, detail.was])).toEqual([
      ["venue.listed", "pre-trading", undefined],
      ["venue.status_changed", "trading", "pre-trading"],
    ]);
  });

  it("leaves out an asset the venue holds on other chains only, even when a Robinhood Chain token shares its symbol", async () => {
    const table = bitget([pair("BTC")], [coin("CASHCAT", [{ chain: "SOL", contractAddress: "So1ana" }])]);
    const { run, news } = harness(BITGET_MARKETS, table);
    await run();
    table[SPOT] = ok([pair("BTC"), pair("CASHCAT")]);
    await run();
    expect(news()).toEqual([]);
  });

  it("matches by the venue's own name for the asset where it gives no contract, and refuses a name that is not the token's", async () => {
    const UPBIT = "https://api.upbit.com/v1/market/all?is_details=true";
    const market = (id: string, english_name: string) => ({ market: id, korean_name: "x", english_name });
    const table: Record<string, () => Response> = { [UPBIT]: json([market("KRW-BTC", "Bitcoin")]) };
    const { run, news } = harness(UPBIT_MARKETS, table);
    await run();
    table[UPBIT] = json([market("KRW-BTC", "Bitcoin"), market("KRW-PONS", "Pons"), market("KRW-CASHCAT", "Cash Cow")]);
    await run();
    expect(news().map(({ token, ref, detail }) => [token, ref, detail.match])).toEqual([[{ address: PONS, symbol: "PONS", name: "Pons" }, `${UPBIT}#KRW-PONS`, "name"]]);
  });

  it("reads Bithumb's list the same way", async () => {
    const BITHUMB = "https://api.bithumb.com/v1/market/all?isDetails=true";
    const table: Record<string, () => Response> = { [BITHUMB]: json([{ market: "KRW-BTC", english_name: "Bitcoin", market_warning: "NONE" }]) };
    const { run, news } = harness(BITHUMB_MARKETS, table);
    await run();
    table[BITHUMB] = json([{ market: "KRW-BTC", english_name: "Bitcoin" }, { market: "KRW-CASHCAT", english_name: "Cash Cat", market_warning: "NONE" }]);
    await run();
    expect(news().map(({ source, token }) => [source, token.address])).toEqual([["Bithumb", CASHCAT]]);
  });

  it("marks a market tied by the symbol alone, and keeps none such from before the watcher began", async () => {
    const table = bitget([pair("BTC")], [], [perp("CASHCAT")]);
    const { run, news, venue } = harness(BITGET_MARKETS, table);
    await run();
    expect(venue()).toEqual([]);
    table[PERPS] = ok([perp("CASHCAT"), perp("PONS", { symbolStatus: "listed" })]);
    await run();
    expect(news().map(({ token, detail }) => [token, detail.type, detail.status, detail.match, detail.unconfirmed, detail.candidates])).toEqual([[{ address: null, symbol: "PONS", name: null }, "perpetual", "pre-trading", "symbol", true, 1]]);
  });

  it("confirms a market tied by symbol with the name the same venue gave the asset in an announcement", async () => {
    const announced: Found = { kind: "venue.announced", token: { address: PONS, symbol: "PONS", name: "Pons" }, source: "Bitget", ref: "https://www.bitget.com/en/support/articles/1", at: null, detail: { venueName: "Pons", match: "name" } };
    const table = bitget([pair("BTC")], []);
    const { run, news } = harness(BITGET_MARKETS, table, [known(PONS, "PONS", "Pons"), announced]);
    await run();
    table[PERPS] = ok([perp("PONS")]);
    await run();
    expect(news().map(({ kind, token, detail }) => [kind, token.address, detail.match])).toEqual([["venue.listed", PONS, "name"]]);
  });

  it("dates a futures market by the onboard date Binance gives it, and leaves out contracts on stocks", async () => {
    const URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
    const symbol = (base: string, underlyingType = "COIN", onboardDate = SEP_6) => ({ symbol: `${base}USDT`, pair: `${base}USDT`, contractType: "PERPETUAL", onboardDate, status: "TRADING", baseAsset: base, quoteAsset: "USDT", underlyingType });
    const table: Record<string, () => Response> = { [URL]: json({ symbols: [symbol("BTC", "COIN", Date.parse("2019-09-08T00:00:00Z"))] }) };
    const { run, news } = harness(BINANCE_FUTURES_MARKETS, table);
    await run();
    table[URL] = json({ symbols: [symbol("BTC", "COIN", Date.parse("2019-09-08T00:00:00Z")), symbol("PONS"), symbol("CASHCAT", "EQUITY")] });
    await run();
    expect(news().map(({ source, token, at, detail }) => [source, token.symbol, at, detail.type, detail.match])).toEqual([["Binance Futures", "PONS", "2026-09-06T06:45:00.000Z", "perpetual", "symbol"]]);
  });

  it("keeps a market from before the watcher began when the venue dates it after the chain's first block", async () => {
    const URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
    const symbol = (base: string, onboardDate: number) => ({ symbol: `${base}USDT`, contractType: "PERPETUAL", onboardDate, status: "TRADING", baseAsset: base, quoteAsset: "USDT", underlyingType: "COIN" });
    const { run, venue } = harness(BINANCE_FUTURES_MARKETS, { [URL]: json({ symbols: [symbol("PONS", SEP_6), symbol("CASHCAT", CHAIN_START - 1)] }) });
    await run();
    expect(venue().map(({ token, at, baseline, detail }) => [token.symbol, at, baseline, detail.unconfirmed])).toEqual([["PONS", "2026-09-06T06:45:00.000Z", true, true]]);
  });

  it("takes a Bitget asset's contract from its coins, for its spot pairs and its perpetuals, and leaves out real-world assets", async () => {
    const BITGET = "https://api.bitget.com/api/v2";
    const ok = (data: unknown[]) => json({ code: "00000", data });
    const symbol = (base: string, openTime: number) => ({ symbol: `${base}USDT`, baseCoin: base, quoteCoin: "USDT", status: "online", openTime: String(openTime) });
    const contract = (base: string, isRwa = "NO") => ({ symbol: `${base}USDT`, baseCoin: base, quoteCoin: "USDT", symbolStatus: "normal", symbolType: "perpetual", isRwa, launchTime: "", openTime: String(Date.parse("2026-08-31T10:35:06Z")) });
    const coins = [{ coin: "PONS", chains: [{ chain: "Robinhood", contractAddress: PONS.toLowerCase() }] }, { coin: "CASHCAT", chains: [{ chain: "Robinhood", contractAddress: CASHCAT.toLowerCase() }] }];
    const table: Record<string, () => Response> = { [`${BITGET}/spot/public/symbols`]: ok([symbol("BTC", 1_600_000_000_000)]), [`${BITGET}/spot/public/coins`]: ok(coins), [`${BITGET}/mix/market/contracts?productType=USDT-FUTURES`]: ok([]) };
    const { run, news } = harness(BITGET_MARKETS, table);
    await run();
    table[`${BITGET}/spot/public/symbols`] = ok([symbol("BTC", 1_600_000_000_000), symbol("PONS", Date.parse("2026-09-07T14:00:00Z"))]);
    table[`${BITGET}/mix/market/contracts?productType=USDT-FUTURES`] = ok([contract("PONS"), contract("CASHCAT", "YES")]);
    await run();
    expect(news().map(({ token, at, detail }) => [token.address, at, detail.type])).toEqual([
      [PONS, "2026-09-07T14:00:00.000Z", "spot"],
      [PONS, "2026-08-31T10:35:06.000Z", "perpetual"],
    ]);
  });

  it("records a market the venue had before the log knew its token as part of the baseline, once the log does", async () => {
    const PAIRS = "https://fapi.binance.com/fapi/v1/exchangeInfo";
    const dir = mkdtempSync(join(tmpdir(), "brainchain-watch-"));
    const log = new EventLog(dir);
    const { requests } = routes({ [PAIRS]: json({ symbols: [{ symbol: "PONSUSDT", contractType: "PERPETUAL", status: "TRADING", baseAsset: "PONS", quoteAsset: "USDT", underlyingType: "COIN", onboardDate: SEP_6 }] }) });
    const poller = marketPoller(requests, BINANCE_FUTURES_MARKETS, universeFrom(log));
    const watcher = new Watcher({ log, state: new StateFile(dir), pollers: [poller], say: () => {} });
    await watcher.runOnce(poller);
    expect(log.size).toBe(0);
    // A list names Pons later: Binance's perpetual for it was there all along, so it goes in as part of the baseline.
    log.append([{ ...known(PONS, "PONS", "Pons"), observedAt: "2026-11-21T00:00:00.000Z" }]);
    await watcher.runOnce(poller);
    expect(log.all().filter(({ kind }) => kind === "venue.listed").map(({ token, at, baseline }) => [token.symbol, at, baseline])).toEqual([["PONS", "2026-09-06T06:45:00.000Z", true]]);
    expect(log.query().events.filter(({ kind }) => kind === "venue.listed")).toEqual([]);
  });

  it("keeps no market from before the watcher that rests on the venue's name alone with no time of its own", async () => {
    const UPBIT = "https://api.upbit.com/v1/market/all?is_details=true";
    const { run, venue } = harness(UPBIT_MARKETS, { [UPBIT]: json([{ market: "KRW-PONS", english_name: "Pons" }]) });
    await run();
    await run();
    expect(venue()).toEqual([]);
  });

  it("fails a read whose answer is not the list, and counts nothing in it as gone", async () => {
    const URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
    const listing = json({ symbols: [{ symbol: "PONSUSDT", contractType: "PERPETUAL", status: "TRADING", baseAsset: "PONS", quoteAsset: "USDT", underlyingType: "COIN", onboardDate: SEP_6 }] });
    const table: Record<string, () => Response> = { [URL]: listing };
    const { run, status, news } = harness(BINANCE_FUTURES_MARKETS, table);
    await run();
    table[URL] = () => new Response("<html>busy</html>");
    await run();
    table[URL] = json({ symbols: [] });
    await run();
    expect(status().failures).toBe(2);
    table[URL] = listing;
    await run();
    expect(news()).toEqual([]);
  });

  it("asks again with the validators a host gave, and reads a 304 as the list it stands for", async () => {
    const UPBIT = "https://api.upbit.com/v1/market/all?is_details=true";
    let etag: string | null = null;
    const answers: Response[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      etag = new Headers(init?.headers).get("if-none-match");
      return answers.shift()!;
    }) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "brainchain-watch-"));
    const log = new EventLog(dir);
    log.append([{ ...known(PONS, "PONS", "Pons"), baseline: true, observedAt: "2026-11-19T00:00:00.000Z" }]);
    const poller = marketPoller(new Requests({ fetch: fetchImpl }), UPBIT_MARKETS, universeFrom(log));
    const watcher = new Watcher({ log, state: new StateFile(dir), pollers: [poller], say: () => {} });
    answers.push(new Response(JSON.stringify([{ market: "KRW-BTC", english_name: "Bitcoin" }]), { headers: { etag: 'W/"1"' } }));
    await watcher.runOnce(poller);
    answers.push(new Response(null, { status: 304 }));
    await watcher.runOnce(poller);
    expect(etag).toBe('W/"1"');
    expect(watcher.status.get(poller.name)!.failures).toBe(0);
    answers.push(new Response(JSON.stringify([{ market: "KRW-BTC", english_name: "Bitcoin" }, { market: "KRW-PONS", english_name: "Pons" }]), { headers: { etag: 'W/"2"' } }));
    await watcher.runOnce(poller);
    expect(log.query().events.map(({ kind, token }) => [kind, token.address])).toEqual([["venue.listed", PONS]]);
  });
});

describe("matching a venue's asset to a Robinhood Chain token", () => {
  const universe = universeOf(
    [known(PONS, "PONS", "Pons"), known(CASHCAT, "CASHCAT", "Cash Cat"), known(OTHER, "CAT", "Cat One"), known(OTHER.replace("B0b", "B0c"), "CAT", "Cat Two")].map((found, i) => ({ ...found, id: i + 1, observedAt: "2026-11-19T00:00:00.000Z", context: {} })),
  );

  it("takes a contract on Robinhood Chain as the token, known to the log or not", () => {
    expect(matchAsset(universe, { base: "NEW", contract: OTHER.replace("B0b", "B0d"), name: "New" })).toMatchObject({ match: "contract", token: { symbol: "NEW", name: "New" } });
  });

  it("folds case and punctuation when it compares names, and wants exactly one token with the name", () => {
    expect(matchAsset(universe, { base: "cashcat", name: "CASH-CAT" })).toMatchObject({ match: "name", token: { address: CASHCAT } });
    expect(matchAsset(universe, { base: "CAT", name: "Cat One" })).toMatchObject({ match: "name", token: { address: OTHER } });
    expect(matchAsset(universe, { base: "CAT", name: "Catcoin" })).toBeUndefined();
  });

  it("gives a symbol alone with no address and the number of tokens that go by it", () => {
    expect(matchAsset(universe, { base: "CAT" })).toEqual({ token: { address: null, symbol: "CAT", name: null }, match: "symbol", candidates: 2 });
    expect(matchAsset(universe, { base: "NOPE" })).toBeUndefined();
  });

  it("never matches a market the venue opened before Robinhood Chain's first block", () => {
    expect(matchAsset(universe, { base: "PONS", contract: PONS, opens: CHAIN_START - 1 })).toBeUndefined();
    expect(matchAsset(universe, { base: "PONS", contract: PONS, opens: CHAIN_START })).toMatchObject({ match: "contract" });
  });
});
