import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, zeroAddress, type Address } from "viem";
import { describe, expect, it, onTestFinished } from "vitest";

import { CALL_COLUMNS, callRecord, type IndexedCall, type SettledCall } from "../calls.js";
import type { ChainHistory } from "../history.js";
import { MARKET_MAKERS } from "../makers.js";
import type { WatchEvent } from "../watch/events.js";
import type { IndexedPool } from "../watch/pools.js";
import { buildDataset, PIECE, trimTail } from "./build.js";
import { FILES, parseJsonl, sha256, type Manifest, type OutcomeRow, type PoolRow, type StepRow } from "./format.js";
import { datasetReader } from "./published.js";
import { poolDir, poolWatcher, robinhoodPageName, titleName, WATCHER_GAP_MS, watcherNames, watcherPace, type PoolSource } from "./sources.js";

const CASHCAT = getAddress("0x020bfc650a365f8bb26819deaabf3e21291018b4");
const MEME = getAddress("0x1111111111111111111111111111111111111111");
const LATER = getAddress("0x2222222222222222222222222222222222222222");
const USDG = getAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
const WINTERMUTE = MARKET_MAKERS[0]!;
const T0 = 1_780_000_000;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

const pool = (version: 3 | 4, token: Address, block: number, n: number): IndexedPool => ({ version, pool: version === 3 ? getAddress(`0x${n.toString(16).padStart(40, "a")}`) : hash(n), currency0: token < USDG ? token : USDG, currency1: token < USDG ? USDG : token, fee: 3000, tickSpacing: 60, ...(version === 4 ? { hooks: zeroAddress } : {}), block });

const namesAbi = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);

/** Robinhood Chain as the build reads it: pools, one approval by Wintermute, empty registries, and each block a second apart. */
function chain(world: { head: number; pools: IndexedPool[]; approvals: { token: Address; block: number }[] }) {
  const asked = { logs: 0 };
  const reader = {
    getBlockNumber: async () => BigInt(world.head),
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: BigInt(T0) + blockNumber }),
    getTransaction: async () => ({ from: WINTERMUTE.wallet, to: zeroAddress }),
    async getLogs(filter: { address?: unknown; event?: { name: string }; events?: unknown; fromBlock: bigint; toBlock: bigint }) {
      asked.logs++;
      const inRange = (block: number) => block >= Number(filter.fromBlock) && block <= Number(filter.toBlock);
      if (filter.event?.name === "Approval") {
        return world.approvals.filter(({ block }) => inRange(block)).map(({ token, block }, i) => ({ address: token, args: { owner: WINTERMUTE.wallet, spender: USDG, value: 1n }, blockNumber: BigInt(block), logIndex: i, transactionHash: hash(block) }));
      }
      if (filter.events) {
        return world.pools
          .filter(({ block }) => inRange(block))
          .map((p) =>
            p.version === 3
              ? { eventName: "PoolCreated", blockNumber: BigInt(p.block), transactionHash: hash(p.block + 1), args: { token0: p.currency0, token1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, pool: p.pool } }
              : { eventName: "Initialize", blockNumber: BigInt(p.block), transactionHash: hash(p.block + 1), args: { id: p.pool, currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: zeroAddress } },
          );
      }
      return [];
    },
    async readContract({ args }: { args: [{ target: Address; callData: `0x${string}` }[]] }) {
      return args[0].map(({ target, callData }) => {
        const { functionName } = decodeFunctionData({ abi: namesAbi, data: callData });
        const value = functionName === "symbol" ? (target === MEME ? "MEME" : target === CASHCAT ? "CASHCAT" : "LATE") : "A token";
        return { success: true, returnData: encodeFunctionResult({ abi: namesAbi, functionName, result: value }) };
      });
    },
  } as unknown as ChainHistory;
  return { reader, asked };
}

function pools(list: () => IndexedPool[], through: () => number): PoolSource {
  return {
    name: "test",
    async page(after) {
      const all = list();
      const pools = all.slice(after, after + 2);
      return { pools, next: after + pools.length, bytes: all.length, through: through() };
    },
  };
}

const baseline = "2026-11-19T09:20:49.454Z";
const watcherEvents = (extra: WatchEvent[] = []): WatchEvent[] => [
  { id: 1, kind: "bitgo.merged", token: { address: CASHCAT, symbol: null, name: "Cash Cat" }, source: "BitGo", ref: "https://github.com/BitGo/BitGoJS/commit/abc", at: "2026-07-28T07:09:00.000Z", observedAt: baseline, detail: { id: "hoodeth:cashcat" }, context: {}, baseline: true },
  { id: 2, kind: "kucoin.listed", token: { address: CASHCAT, symbol: "CASHCAT", name: "Cash Cat" }, source: "KuCoin", ref: "https://api.kucoin.com/api/v3/currencies", at: null, observedAt: baseline, detail: {}, context: {}, baseline: true },
  ...extra,
];

function web(events: () => WatchEvent[], names: () => Record<string, { name: string; at: string }> | undefined = () => undefined, calls: () => IndexedCall[] | undefined = () => []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.host === "watch.test" && url.pathname === "/calls") {
      const all = calls();
      if (!all) return Response.json({ error: "This watcher does not read calls." }, { status: 404 });
      const after = Number(url.searchParams.get("after"));
      const page = all.slice(after, after + 1);
      return Response.json({ readAt: "2026-11-21T00:00:00.000Z", total: all.length, after, next: after + page.length, more: after + page.length < all.length, calls: page });
    }
    if (url.host === "watch.test" && url.pathname === "/robinhood/names") {
      const read = names();
      return read ? Response.json({ readAt: "2026-11-21T00:00:00.000Z", pages: Object.keys(read).length, names: read }) : Response.json({ error: "Not found." }, { status: 404 });
    }
    if (url.host === "watch.test") return Response.json({ events: events(), next: events().length, more: false });
    if (url.host === "api.kucoin.com") return Response.json({ data: [{ baseCurrency: "CASHCAT", tradingStartTime: Date.parse("2026-07-15T10:00:00Z") }] });
    if (url.host === "api.gateio.ws") return Response.json([]);
    return new Response("not here", { status: 404 });
  }) as typeof fetch;
}

const lines = <T>(path: string) => parseJsonl<T>(readFileSync(path, "utf8"));

describe("the dataset build", () => {
  it("writes the files publish.mjs takes, appends on the next build and never changes a row written before", async () => {
    const out = mkdtempSync(join(tmpdir(), "dataset-"));
    const world = { head: 25_000, pools: [pool(4, CASHCAT, 9_500, 1), pool(3, MEME, 12_000, 2), pool(4, MEME, 14_000, 3)], approvals: [{ token: CASHCAT, block: 15_000 }, { token: CASHCAT, block: 16_000 }] };
    const { reader } = chain(world);
    let events = watcherEvents();
    let clock = Date.parse("2026-11-20T22:00:00Z");
    const options = { out, watcher: new URL("https://watch.test"), pools: pools(() => world.pools, () => world.head), reader, span: 10_000, wallets: [WINTERMUTE], fetch: web(() => events), now: () => new Date(clock) };

    const first = await buildDataset(options);
    expect(first.complete).toBe(true);
    expect(first).toMatchObject({ date: "2026-11-20", headBlock: 25_000, through: { head: 25_000, pools: 25_000, approvals: 25_000 } });
    const manifest = JSON.parse(readFileSync(join(out, "manifests", "2026-11-20.json"), "utf8")) as Manifest;
    expect(Object.keys(manifest.files)).toEqual(expect.arrayContaining([...FILES, "pools/000.jsonl"]));
    for (const [path, { sha256: digest, rows }] of Object.entries(manifest.files)) {
      const bytes = readFileSync(join(out, path));
      expect(sha256(bytes), path).toBe(digest);
      if (path.endsWith(".jsonl")) expect(bytes.toString("utf8").trim().split("\n").filter(Boolean), path).toHaveLength(rows);
    }
    const steps = lines<StepRow>(join(out, "events.jsonl"));
    expect(steps.map(({ step, source }) => `${step} ${source}`).sort()).toEqual(["approval Robinhood Chain", "custody BitGo", "pool Uniswap v4"]);
    expect(steps.find(({ step }) => step === "approval")).toMatchObject({ token: CASHCAT, at: new Date((T0 + 15_000) * 1000).toISOString(), block: 15_000, confirmed: true, backfill: true });
    expect(steps.find(({ step }) => step === "pool")).toMatchObject({ token: CASHCAT, block: 9_500, transaction: hash(9_501), pool: hash(1), pairedWith: USDG });
    expect(lines<PoolRow>(join(out, "pools/000.jsonl")).map(({ token, source, block }) => [token, source, block])).toEqual([
      [CASHCAT, "Uniswap v4", 9_500],
      [MEME, "Uniswap v3", 12_000],
      [MEME, "Uniswap v4", 14_000],
    ]);
    const outcomes = readFileSync(join(out, "outcomes.jsonl"), "utf8");
    expect(outcomes).toContain('"outcome":"kucoin","venue":"KuCoin","at":"2026-07-15T10:00:00.000Z","atFrom":"source"');
    expect(outcomes).not.toContain("Bitstamp");
    const rates = JSON.parse(readFileSync(join(out, "base-rates.json"), "utf8"));
    expect(rates.pools).toMatchObject({ piece: PIECE, counts: [1, 1, 0] });
    expect(rates.through.wallets).toEqual([WINTERMUTE.wallet]);
    const feed = JSON.parse(readFileSync(join(out, "feed.json"), "utf8"));
    expect(feed.version).toBe("https://jsonfeed.org/version/1.1");
    expect(readFileSync(join(out, "feed.xml"), "utf8")).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<rss version="2.0">/);
    expect(readFileSync(join(out, "events.csv"), "utf8").split("\n")[0]).toBe("token,step,source,at,by,atFrom,block,transaction,ref,observedAt,backfill");

    const before = { events: readFileSync(join(out, "events.jsonl")), pools: readFileSync(join(out, "pools/000.jsonl")), outcomes: readFileSync(join(out, "outcomes.jsonl")) };
    world.head = 31_000;
    world.pools.push(pool(4, LATER, 30_500, 4), pool(4, MEME, 30_600, 5));
    world.approvals.push({ token: LATER, block: 30_800 });
    events = watcherEvents([
      { id: 3, kind: "lifi.listed", token: { address: LATER, symbol: "LATE", name: "Late" }, source: "LI.FI", ref: "https://li.quest", at: null, observedAt: "2026-11-21T08:00:00.000Z", detail: {}, context: {} },
    ]);
    clock = Date.parse("2026-11-21T00:40:00Z");
    const second = await buildDataset(options);
    expect(second).toMatchObject({ date: "2026-11-21", headBlock: 31_000, complete: true });
    for (const [name, path] of [["events", "events.jsonl"], ["pools", "pools/000.jsonl"], ["outcomes", "outcomes.jsonl"]] as const) {
      const now = readFileSync(join(out, path));
      expect(now.subarray(0, before[name].length).equals(before[name]), path).toBe(true);
    }
    const added = lines<StepRow>(join(out, "events.jsonl")).slice(steps.length);
    expect(added.map(({ step, token }) => `${step} ${token}`).sort()).toEqual([`aggregator ${LATER}`, `approval ${LATER}`, `pool ${LATER}`]);
    expect(added.every((row) => row.backfill === undefined)).toBe(true);
    expect(lines<PoolRow>(join(out, "pools/000.jsonl"))).toHaveLength(4);
    const third = await buildDataset(options);
    expect(third.added).toEqual({});
  });

  it("writes every call recorded by readAt, settled as brainchain_calls settles it from the same day's files, and keeps them when the watcher cannot serve them", async () => {
    const out = mkdtempSync(join(tmpdir(), "dataset-"));
    const world = { head: 25_000, pools: [pool(4, CASHCAT, 9_500, 1), pool(3, MEME, 12_000, 2)], approvals: [] };
    const { reader } = chain(world);
    const call = (n: number, more: Partial<IndexedCall>): IndexedCall => ({
      token: MEME,
      outcome: "any",
      days: 7,
      dataset: { date: "2026-11-20", manifest: "ab".repeat(32) },
      grade: hash(n),
      decision: String(n),
      at: "2026-11-20T12:00:00.000Z",
      payer: n % 2 ? WINTERMUTE.wallet : CASHCAT,
      network: "eip155:8453",
      amount: "250000",
      accepted: n !== 3,
      record: `https://brain.usebrainchain.com/records/${hash(n)}.json`,
      ...more,
    });
    const made = [
      call(1, { token: CASHCAT, outcome: "kucoin", at: "2026-07-10T00:00:00.000Z" }),
      call(2, { token: CASHCAT, outcome: "kucoin", at: "2026-11-19T00:00:00.000Z" }),
      call(3, { at: "2026-11-10T00:00:00.000Z" }),
      call(4, { outcome: "gate", days: 30 }),
      call(5, { at: "2026-11-20T23:00:00.000Z" }),
    ];
    let served: IndexedCall[] | undefined = made;
    let clock = Date.parse("2026-11-20T22:00:00Z");
    const options = { out, watcher: new URL("https://watch.test"), pools: pools(() => world.pools, () => world.head), reader, span: 10_000, wallets: [WINTERMUTE], fetch: web(() => watcherEvents(), undefined, () => served), now: () => new Date(clock) };
    // The fake watcher serves one call a page, so the build reads several pages: unpaced here, and paced again after.
    watcherPace(options.watcher, { gap: 0 });
    onTestFinished(() => void watcherPace(options.watcher, { gap: WATCHER_GAP_MS }));

    const first = await buildDataset(options);
    expect(first.added["calls.jsonl"]).toBe(4);
    const written = lines<SettledCall>(join(out, "calls.jsonl"));
    expect(written.map(({ decision, settled }) => `${decision} ${settled}`)).toEqual(["1 hit", "3 miss", "2 already public", "4 pending"]);
    expect(written[0]).toMatchObject({ deadline: "2026-07-17T00:00:00.000Z", by: { outcome: "kucoin", venue: "KuCoin", at: "2026-07-15T10:00:00.000Z" } });
    const read = await datasetReader(out).load();
    for (const payer of [WINTERMUTE.wallet, CASHCAT]) {
      const mine = made.slice(0, 4).filter((one) => one.payer === payer);
      expect(callRecord(payer, mine, read).calls.sort((a, b) => a.at.localeCompare(b.at)), payer).toEqual(written.filter((one) => one.payer === payer));
    }
    const csv = readFileSync(join(out, "calls.csv"), "utf8").split("\n");
    expect(csv[0]).toBe(CALL_COLUMNS.join(","));
    expect(csv[1]).toBe(`1,${hash(1)},2026-07-10T00:00:00.000Z,${WINTERMUTE.wallet},${CASHCAT},kucoin,7,2026-07-17T00:00:00.000Z,true,hit,kucoin,KuCoin,2026-07-15T10:00:00.000Z,https://api.kucoin.com/api/v3/currencies,,eip155:8453,250000,2026-11-20,${"ab".repeat(32)},https://brain.usebrainchain.com/records/${hash(1)}.json`);
    const manifest = JSON.parse(readFileSync(join(out, "manifests", "2026-11-20.json"), "utf8")) as Manifest;
    expect([manifest.files["calls.jsonl"]?.rows, manifest.files["calls.csv"]?.rows]).toEqual([4, 4]);

    clock = Date.parse("2026-11-21T00:40:00Z");
    const second = await buildDataset(options);
    expect(second.added["calls.jsonl"]).toBe(1);
    expect(lines<SettledCall>(join(out, "calls.jsonl")).map(({ decision }) => decision)).toEqual(["1", "3", "2", "4", "5"]);

    served = undefined;
    clock = Date.parse("2026-12-21T00:40:00Z");
    const third = await buildDataset(options);
    expect(third.notes).toContain("The watcher's calls could not be read (watch.test answered 404: {\"error\":\"This watcher does not read calls.\"}.), so calls.jsonl holds the 5 an earlier build read.");
    expect(lines<SettledCall>(join(out, "calls.jsonl")).map(({ decision, settled }) => `${decision} ${settled}`)).toEqual(["1 hit", "3 miss", "2 already public", "4 miss", "5 miss"]);
  });

  it("stops a scan when its time is up, says so, and goes on from there the next time", async () => {
    const out = mkdtempSync(join(tmpdir(), "dataset-"));
    const world = { head: 60_000, pools: [pool(4, MEME, 10_000, 1)], approvals: [{ token: MEME, block: 55_000 }] };
    const { reader } = chain(world);
    const options = { out, watcher: new URL("https://watch.test"), pools: pools(() => world.pools, () => world.head), reader, span: 10_000, wallets: [WINTERMUTE], fetch: web(() => []), budgetMs: -1 };
    const cut = await buildDataset(options);
    expect(cut.complete).toBe(false);
    expect(cut.notes.join(" ")).toMatch(/approvals are read through block \d+ of 60000/);
    const done = await buildDataset({ ...options, budgetMs: 60_000 });
    expect(done.complete).toBe(true);
    expect(readFileSync(join(out, "events.jsonl"), "utf8")).toContain('"step":"approval"');
  });

  it("confirms a Robinhood page by the name the watcher read, and settles the row an earlier build left unconfirmed", async () => {
    const out = mkdtempSync(join(tmpdir(), "dataset-"));
    const world = { head: 12_000, pools: [pool(4, CASHCAT, 9_500, 1)], approvals: [] };
    const { reader } = chain(world);
    const page: WatchEvent = { id: 3, kind: "robinhood.page_added", token: { address: null, symbol: "CASHCAT", name: null }, source: "Robinhood", ref: "https://robinhood.com/us/en/crypto/CASHCAT/", at: null, observedAt: baseline, detail: {}, context: {}, baseline: true };
    let names: Record<string, { name: string; at: string }> | undefined;
    const options = { out, watcher: new URL("https://watch.test"), pools: pools(() => world.pools, () => world.head), reader, span: 10_000, wallets: [WINTERMUTE], fetch: web(() => watcherEvents([page]), () => names) };
    const rows = () => lines<OutcomeRow>(join(out, "outcomes.jsonl")).filter(({ outcome }) => outcome === "robinhood_page");
    const unconfirmed = () => JSON.parse(readFileSync(join(out, "base-rates.json"), "utf8")).unconfirmed;

    // A watcher older than 0.16.2 has no names, and the page read from outside the US has none.
    await buildDataset(options);
    expect(rows().map(({ match, unconfirmed }) => ({ match, unconfirmed }))).toEqual([{ match: "symbol", unconfirmed: true }]);
    expect(unconfirmed()).toBe(1);

    names = { CASHCAT: { name: "Cash Cat", at: "2026-11-21T00:00:00.000Z" } };
    await buildDataset(options);
    expect(rows().map(({ match, name, unconfirmed }) => ({ match, name, unconfirmed }))).toEqual([
      { match: "symbol", name: undefined, unconfirmed: true },
      { match: "name", name: "Cash Cat", unconfirmed: undefined },
    ]);
    expect(unconfirmed()).toBe(0);
  });

  it("cuts a last line a killed build left half written, and leaves a whole file as it is", () => {
    const dir = mkdtempSync(join(tmpdir(), "dataset-"));
    const path = join(dir, "events.jsonl");
    writeFileSync(path, '{"a":1}\n{"b":2}\n{"c":');
    trimTail(path);
    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"b":2}\n');
    trimTail(path);
    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"b":2}\n');
    writeFileSync(path, '{"only":');
    trimTail(path);
    expect(readFileSync(path, "utf8")).toBe("");
  });

  it("asks a watcher at most once a gap, under its 120 a minute, and waits out a 429 for as long as it says", async () => {
    let now = 0;
    const slept: number[] = [];
    const pace = watcherPace(new URL("https://watch.pace"), { gap: 600, clock: () => now, sleep: async (ms) => void (slept.push(ms), (now += ms)) });
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 2) return new Response('{"error":"An address can make 120 requests a minute."}', { status: 429, headers: { "retry-after": "7" } });
      return Response.json({ pools: [], next: calls * 10, bytes: 30, through: 1, ready: true });
    }) as unknown as typeof fetch;
    const source = poolWatcher(new URL("https://watch.pace"), fetchImpl, pace);
    expect((await source.page(0)).next).toBe(10);
    expect((await source.page(10)).next).toBe(30);
    expect(slept).toEqual([600, 7_000]);
    const refusing = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    await expect(poolWatcher(new URL("https://watch.pace"), refusing, watcherPace(new URL("https://watch.pace"), { gap: 0, sleep: async () => {} })).page(0)).rejects.toThrow(/answered 429/);
  });

  it("reads a watcher's pool index on this machine without writing to it, only as far as its checkpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "watch-"));
    const lineOf = (p: IndexedPool) => `${JSON.stringify(p)}\n`;
    const kept = lineOf(pool(3, MEME, 12_000, 2));
    writeFileSync(join(dir, "pools.jsonl"), kept + lineOf(pool(4, LATER, 13_000, 3)).slice(0, 40));
    writeFileSync(join(dir, "pools.checkpoint.json"), JSON.stringify({ from: 8_930, through: 12_500, bytes: Buffer.byteLength(kept), pools: 1, updatedAt: "x" }));
    const source = poolDir(dir);
    expect(await source.page(0)).toEqual({ pools: [pool(3, MEME, 12_000, 2)], next: Buffer.byteLength(kept), bytes: Buffer.byteLength(kept), through: 12_500 });
    expect(await source.page(Buffer.byteLength(kept))).toMatchObject({ pools: [] });
    expect(() => poolDir(join(dir, "nothing"))).toThrow(/holds no pool index/);
  });
});

describe("Robinhood's page names", () => {
  it("reads the name in each form Robinhood's pages title it, and nothing from any other title", () => {
    expect(titleName("Buy and sell Cash Cat (CASHCAT) and 20+ other crypto on Robinhood", "CASHCAT")).toBe("Cash Cat");
    expect(titleName("Pons - PONS Price Today, Live Charts and News - Robinhood", "PONS")).toBe("Pons");
    expect(titleName("Orbio.so - ORBIO Price Today, Live Charts and News - Robinhood", "ORBIO")).toBe("Orbio.so");
    expect(titleName("Cash Cat (CASHCAT) \u2014 Buy and sell commission-free on Robinhood", "CASHCAT")).toBe("Cash Cat");
    expect(titleName("Buy and sell Cash Cat (CASHCAT) and 20+ other crypto on Robinhood", "CASH")).toBe("");
    expect(titleName("Crypto prices today - Robinhood", "PONS")).toBe("");
    expect(titleName("Robinhood: Pons (PONS)", "PONS")).toBe("");
  });

  it("reads a page's head for the name, and a page Robinhood does not have as none", async () => {
    const head = (title: string) => `<html><head><meta content="${title}" property="og:title"/></head><body>${"x".repeat(1000)}</body></html>`;
    const pages = (async (input: RequestInfo | URL) => {
      const symbol = /crypto\/([A-Z]+)\//.exec(String(input))?.[1];
      if (symbol === "PONS") return new Response(head("Pons - PONS Price Today, Live Charts and News - Robinhood"));
      if (symbol === "CASHCAT") return new Response(head("Buy and sell Cash Cat (CASHCAT) and 20+ other crypto on Robinhood"));
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;
    expect(await robinhoodPageName("PONS", pages)).toBe("Pons");
    expect(await robinhoodPageName("CASHCAT", pages)).toBe("Cash Cat");
    expect(await robinhoodPageName("ORE", pages)).toBe("");
  });

  it("takes a watcher's page names, and nothing from a watcher older than the route", async () => {
    const names = { pons: { name: "Pons", at: "2026-11-21T10:00:00.000Z" }, ORE: { name: "", at: "2026-11-21T10:00:01.000Z" }, BAD: { name: 1 } };
    const serving = (async () => Response.json({ readAt: "2026-11-21T10:05:00.000Z", pages: 3, names })) as unknown as typeof fetch;
    const older = (async () => Response.json({ error: "Not found." }, { status: 404 })) as unknown as typeof fetch;
    const quick = () => watcherPace(new URL("https://watch.names"), { gap: 0, sleep: async () => {} });
    const read = await watcherNames(new URL("https://watch.names"), serving, quick());
    expect(read?.readAt).toBe("2026-11-21T10:05:00.000Z");
    expect([...read!.names]).toEqual([
      ["PONS", { name: "Pons", at: "2026-11-21T10:00:00.000Z" }],
      ["ORE", { name: "", at: "2026-11-21T10:00:01.000Z" }],
    ]);
    expect(await watcherNames(new URL("https://watch.names"), older, quick())).toBeUndefined();
    const wrong = (async () => Response.json({ events: [] })) as unknown as typeof fetch;
    await expect(watcherNames(new URL("https://watch.names"), wrong, quick())).rejects.toThrow(/did not answer with Robinhood's page names/);
  });
});
