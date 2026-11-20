import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventLog } from "./events.js";
import { Requests } from "./http.js";
import { StateFile } from "./state.js";
import { coingecko, gate, kucoin, lifi, robinhoodPages, robinhoodPairs } from "./venues.js";
import { Watcher, type Poller } from "./watcher.js";

const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const PONS = "0x0000000000000000000000000000000000000B0b";
const PAIRS = "https://nummus.robinhood.com/currency_pairs/";
const SITEMAP = "https://robinhood.com/us/en/sitemap-crypto.xml";

function routes(table: Record<string, () => Response>) {
  const asked: { url: string; etag: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ url: String(input), etag: new Headers(init?.headers).get("if-none-match") });
    return table[String(input)]?.() ?? new Response("Not Found", { status: 404 });
  }) as typeof fetch;
  return { requests: new Requests({ fetch: fetchImpl }), asked, table };
}

function harness(poller: Poller) {
  const dir = mkdtempSync(join(tmpdir(), "brainchain-watch-"));
  const log = new EventLog(dir);
  const watcher = new Watcher({ log, state: new StateFile(dir), pollers: [poller], say: () => {} });
  return { log, run: () => watcher.runOnce(poller), status: () => watcher.status.get(poller.name)! };
}

const json = (value: unknown, etag?: string) => () => new Response(JSON.stringify(value), { headers: etag ? { etag } : {} });
const pair = (code: string, name: string, tradability: "tradable" | "untradable") => ({ symbol: `${code}-USD`, tradability, asset_currency: { code, name } });
const sitemap = (...symbols: string[]) => () => new Response(`<urlset>${symbols.map((symbol) => `<url><loc>https://robinhood.com/us/en/crypto/${symbol}/</loc></url>`).join("")}</urlset>`);

describe("Robinhood's pair list", () => {
  it("reports a pair that appears, and a pair whose tradability changes, each once", async () => {
    const { requests, table } = routes({ [PAIRS]: json({ next: null, results: [pair("BTC", "Bitcoin", "tradable"), pair("PONS", "Pons", "untradable")] }) });
    const { log, run } = harness(robinhoodPairs(requests));
    await run();
    expect(log.all().every(({ baseline }) => baseline)).toBe(true);
    table[PAIRS] = json({ next: null, results: [pair("BTC", "Bitcoin", "tradable"), pair("PONS", "Pons", "tradable"), pair("CASHCAT", "Cash Cat", "untradable")] });
    await run();
    await run();
    expect(log.query().events.map(({ kind, token, detail }) => [kind, token, detail])).toEqual([
      ["robinhood.tradability_changed", { address: null, symbol: "PONS", name: "Pons" }, { tradable: true, was: false, pairsRead: 3 }],
      ["robinhood.pair_added", { address: null, symbol: "CASHCAT", name: "Cash Cat" }, { tradable: false, pairsRead: 3 }],
    ]);
  });

  it("reports nothing from an answer that is not the list, and does not count a missing pair as a change", async () => {
    const { requests, table } = routes({ [PAIRS]: json({ next: null, results: [pair("PONS", "Pons", "untradable")] }) });
    const { log, run, status } = harness(robinhoodPairs(requests));
    await run();
    table[PAIRS] = () => new Response("<html>busy</html>");
    await run();
    expect(status().failures).toBe(1);
    table[PAIRS] = json({ next: null, results: [] });
    await run();
    table[PAIRS] = json({ next: null, results: [pair("PONS", "Pons", "untradable")] });
    await run();
    expect(log.query().events).toEqual([]);
  });
});

describe("Robinhood's crypto pages", () => {
  it("reports a symbol that gets a page", async () => {
    const { requests, table } = routes({ [SITEMAP]: sitemap("BTC") });
    const { log, run } = harness(robinhoodPages(requests));
    await run();
    table[SITEMAP] = sitemap("BTC", "pons");
    await run();
    expect(log.query().events.map(({ kind, token, ref }) => [kind, token.symbol, ref])).toEqual([["robinhood.page_added", "PONS", "https://robinhood.com/us/en/crypto/PONS/"]]);
  });
});

describe("the lists matched by contract", () => {
  it("report a token whose contract appears on KuCoin, with its deposits and withdrawals, and ask with the ETag", async () => {
    const URL = "https://api.kucoin.com/api/v3/currencies";
    const currency = (code: string, contract: string) => ({ currency: code, fullName: code, chains: [{ chainId: "robinhood", contractAddress: contract, isDepositEnabled: true, isWithdrawEnabled: false }] });
    const { requests, table, asked } = routes({ [URL]: json({ data: [currency("CASHCAT", CASHCAT)] }, '"k1"') });
    const { log, run } = harness(kucoin(requests));
    await run();
    table[URL] = () => new Response(null, { status: 304 });
    await run();
    expect(asked.at(-1)!.etag).toBe('"k1"');
    table[URL] = json({ data: [currency("CASHCAT", CASHCAT), currency("PONS", PONS)] }, '"k2"');
    await run();
    expect(log.query().events.map(({ kind, token, source, ref, detail }) => [kind, token, source, ref, detail])).toEqual([
      ["kucoin.listed", { address: PONS, symbol: "PONS", name: "PONS" }, "KuCoin", URL, { deposits: true, withdrawals: false }],
    ]);
  });

  it("read Gate, LI.FI and CoinGecko the same way", async () => {
    const answers = {
      gate: ["https://api.gateio.ws/api/v4/spot/currencies", (address: string) => json([{ currency: "PONS", name: "Pons", delisted: false, chains: [{ name: "ROBINHOOD", addr: address, deposit_disabled: false, withdraw_disabled: false }] }])],
      lifi: ["https://li.quest/v1/tokens?chains=4663", (address: string) => json({ tokens: { 4663: [{ address, chainId: 4663, symbol: "PONS", name: "Pons" }] } })],
      coingecko: ["https://tokens.coingecko.com/robinhood/all.json", (address: string) => json({ tokens: [{ address: address.toLowerCase(), chainId: 4663, symbol: "PONS", name: "Pons" }] })],
    } as const;
    for (const [name, poller] of [["gate", gate], ["lifi", lifi], ["coingecko", coingecko]] as const) {
      const [url, answer] = answers[name];
      const { requests, table } = routes({ [url]: answer(CASHCAT) });
      const { log, run } = harness(poller(requests));
      await run();
      table[url] = answer(PONS);
      await run();
      expect(log.query().events.map(({ kind, token }) => [kind, token.address])).toEqual([[`${name}.listed`, PONS]]);
    }
  });
});
