import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventLog, type Found } from "./events.js";
import { universeFrom, universeOf } from "./exchanges.js";
import { Requests } from "./http.js";
import { BITGET_NOTICES, BITHUMB_NOTICES, KRAKEN_BLOG, matchNotice, namedIn, noticePoller, type NoticeSource } from "./notices.js";
import { StateFile } from "./state.js";
import { Watcher } from "./watcher.js";

const PONS = "0x39dBED3a2bd333467115dE45665cC57F813C4571";
const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const BITFI = "0x00000000000000000000000000000000000B1f10";

const known = (address: string, symbol: string, name: string): Found => ({ kind: "coingecko.listed", token: { address, symbol, name }, source: "CoinGecko", ref: "https://tokens.coingecko.com/robinhood/all.json", at: null, detail: {} });
const TOKENS = [known(PONS, "PONS", "Pons"), known(CASHCAT, "CASHCAT", "Cash Cat"), known(BITFI, "BFI", "BitFi")];

function harness(source: NoticeSource, table: Record<string, () => Response>) {
  const dir = mkdtempSync(join(tmpdir(), "brainchain-watch-"));
  const log = new EventLog(dir);
  log.append(TOKENS.map((token) => ({ ...token, baseline: true as const, observedAt: "2026-11-19T09:20:00.000Z" })));
  const fetchImpl = (async (input: RequestInfo | URL) => table[String(input)]?.() ?? new Response("Not Found", { status: 404 })) as typeof fetch;
  const poller = noticePoller(new Requests({ fetch: fetchImpl }), source, universeFrom(log));
  const watcher = new Watcher({ log, state: new StateFile(dir), pollers: [poller], say: () => {} });
  return { log, run: () => watcher.runOnce(poller), status: () => watcher.status.get(poller.name)!, news: () => log.query().events, kept: () => log.all().filter(({ kind }) => kind === "venue.announced") };
}

const json = (value: unknown) => () => new Response(JSON.stringify(value));

describe("an announcement's title", () => {
  it("gives the symbols it names, with the text beside each that may hold its name", () => {
    expect(namedIn("Bitget lists Pons (PONS) in the Innovation Zone")).toEqual([{ symbol: "PONS", before: "Bitget lists Pons" }]);
    expect(namedIn("Bitget adds SLX/USDT (Solstice) for spot trading")).toEqual([{ symbol: "SLX", name: "Solstice" }]);
    expect(namedIn("Bitget lists PONSUSDT perpetual futures with up to 20x leverage")).toEqual([{ symbol: "PONS" }]);
    expect(namedIn("Bitget opens PROS/USD and PROS/EUR for spot trading")).toEqual([{ symbol: "PROS" }]);
    expect(namedIn("Bitget Announcement on the Listing of JNJUSDT and AMDLUSDT")).toEqual([{ symbol: "JNJ" }, { symbol: "AMDL" }]);
  });
});

describe("the tokens an announcement names", () => {
  const universe = universeOf(TOKENS.map((found, i) => ({ ...found, id: i + 1, observedAt: "2026-11-19T00:00:00.000Z", context: {} })));

  it("are those whose name stands right before the symbol, or the symbol's only token when no name does", () => {
    expect(matchNotice(universe, { named: namedIn("Bitget lists Pons (PONS) in the Innovation Zone") })).toEqual([{ token: { address: PONS, symbol: "PONS", name: "Pons" }, match: "name", venueName: "Pons" }]);
    expect(matchNotice(universe, { named: namedIn("Bitget lists CASHCATUSDT perpetual futures") })).toEqual([{ token: { address: null, symbol: "CASHCAT", name: null }, match: "symbol", candidates: 1 }]);
  });

  it("leave out a symbol whose name beside it is another asset's", () => {
    expect(matchNotice(universe, { named: namedIn("Bitget lists Ponzi Finance (PONS) in the Innovation Zone") })).toEqual([]);
    expect(matchNotice(universe, { named: namedIn("Bitget adds PONS/USDT (Pontoon) for spot trading") })).toEqual([]);
  });

  it("take a contract in the text that the log knows, before anything else", () => {
    expect(matchNotice(universe, { named: [{ symbol: "PONS", before: "Something Else" }], contracts: [PONS.toLowerCase()] })).toMatchObject([{ match: "contract", token: { address: PONS } }]);
  });
});

describe("a venue's announcements", () => {
  const BITGET = BITGET_NOTICES.url;
  const item = (annId: string, annTitle: string, annSubType = "spot", cTime = Date.parse("2026-09-07T10:00:00Z")) => ({ annId, annTitle, annType: "coin_listings", annSubType, annUrl: `https://www.bitget.com/en/support/articles/${annId}`, cTime: String(cTime) });
  const answer = (...items: unknown[]) => json({ code: "00000", msg: "success", data: items });

  it("report a new one that names a token, dated by the venue, and keep what was there at the start as the baseline", async () => {
    const old = item("1", "Bitget lists CASHCATUSDT perpetual futures");
    const table: Record<string, () => Response> = { [BITGET]: answer(item("2", "Bitget lists Cash Cat (CASHCAT) in the Innovation Zone"), old) };
    const { run, news, kept } = harness(BITGET_NOTICES, table);
    await run();
    // A name confirms the old spot listing for the baseline; the one by symbol alone is left out.
    expect(kept().map(({ token, baseline, detail }) => [token.address, baseline, detail.match])).toEqual([[CASHCAT, true, "name"]]);
    table[BITGET] = answer(item("4", "Bitget lists Pons (PONS) in the Innovation Zone", "spot", Date.parse("2026-09-07T13:00:00Z")), item("3", "Bitget spot copy trade now supports PONS/USDT", "copy_trading"), item("5", "Bitget Announcement on the Listing of CASHCATUSDT Stock Perps", "futures"), old);
    await run();
    await run();
    expect(news().map(({ kind, token, source, ref, at, detail }) => [kind, token.address, source, ref, at, detail.match])).toEqual([["venue.announced", PONS, "Bitget", "https://www.bitget.com/en/support/articles/4", "2026-09-07T13:00:00.000Z", "name"]]);
  });

  it("report a new one that names a token by symbol alone, marked as such", async () => {
    const table: Record<string, () => Response> = { [BITGET]: answer(item("1", "Bitget lists Bitcoin (BTC)")) };
    const { run, news } = harness(BITGET_NOTICES, table);
    await run();
    table[BITGET] = answer(item("2", "Bitget lists PONSUSDT perpetual futures with up to 20x leverage"));
    await run();
    expect(news().map(({ token, detail }) => [token, detail.unconfirmed])).toEqual([[{ address: null, symbol: "PONS", name: null }, true]]);
  });

  it("read Bithumb's market-added notices in Korean time, by symbol alone", async () => {
    const notice = (id: number, category: string, title: string, published_at: string) => ({ categories: [category], title, pc_url: `https://feed.bithumb.com/notice/${id}`, published_at, modified_at: published_at });
    const table: Record<string, () => Response> = { [BITHUMB_NOTICES.url]: json([notice(1, "마켓 추가", "키네틱(KNTQ) 원화 마켓 추가", "2026-11-19 11:58:59")]) };
    const { run, news } = harness(BITHUMB_NOTICES, table);
    await run();
    table[BITHUMB_NOTICES.url] = json([notice(3, "입출금", "폰즈(PONS) 입출금 일시 중지 안내", "2026-10-09 10:00:00"), notice(2, "마켓 추가", "폰즈(PONS) 원화 마켓 추가", "2026-10-08 17:00:00"), notice(1, "마켓 추가", "키네틱(KNTQ) 원화 마켓 추가", "2026-11-19 11:58:59")]);
    await run();
    expect(news().map(({ token, at, ref, detail }) => [token.symbol, at, ref, detail.match])).toEqual([["PONS", "2026-10-08T08:00:00.000Z", "https://feed.bithumb.com/notice/2", "symbol"]]);
  });

  it("read Kraken's Asset Listings feed, with the name in the post's text", async () => {
    const post = (symbol: string, name: string, date: string, guid: number) =>
      `<item><title>${symbol} is available for trading!</title><link>https://blog.kraken.com/product/asset-listings/${symbol.toLowerCase()}</link><pubDate>${date}</pubDate><guid isPermaLink="false">https://blog.kraken.com/?p=${guid}</guid><content:encoded><![CDATA[<p>Here&#8217;s some more information about this asset : <strong>${name} (${symbol})</strong></p>]]></content:encoded></item>`;
    const feed = (...items: string[]) => () => new Response(`<?xml version="1.0"?><rss version="2.0"><channel>${items.join("")}</channel></rss>`, { headers: { etag: `W/"${items.length}"` } });
    const table: Record<string, () => Response> = { [KRAKEN_BLOG.url]: feed(post("ZCHF", "Frankencoin", "Thu, 08 Oct 2026 15:53:48 +0000", 1)) };
    const { run, news } = harness(KRAKEN_BLOG, table);
    await run();
    table[KRAKEN_BLOG.url] = feed(post("BFI", "BitFi", "Fri, 20 Nov 2026 17:22:13 +0000", 2), post("ZCHF", "Frankencoin", "Thu, 08 Oct 2026 15:53:48 +0000", 1));
    await run();
    expect(news().map(({ token, source, ref, at, detail }) => [token, source, ref, at, detail.venueName])).toEqual([
      [{ address: BITFI, symbol: "BFI", name: "BitFi" }, "Kraken", "https://blog.kraken.com/product/asset-listings/bfi", "2026-11-20T17:22:13.000Z", "BitFi"],
    ]);
  });

  it("fail a read whose answer is not the announcements", async () => {
    const { run, status } = harness(BITGET_NOTICES, { [BITGET]: () => new Response("<html>busy</html>") });
    await run();
    expect(status().failures).toBe(1);
    expect(() => KRAKEN_BLOG.parse("<html>busy</html>")).toThrow("did not answer with its feed");
  });
});
