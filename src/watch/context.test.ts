import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAddress, type Address, type Hash } from "viem";
import { describe, expect, it } from "vitest";

import type { ReadinessBoard } from "../readiness.js";
import type { SightingsBoard } from "../sightings.js";
import { ChainError, type History as History } from "../history.js";
import type { MarketCapBoard } from "../marketcap.js";
import { custodyFromLog, eventContext, worthOf } from "./context.js";
import { EventLog, type Found, type WatchEvent } from "./events.js";

const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4" as Address;
const OTHER = getAddress("0x0000000000000000000000000000000000000c0c");
const TX = `0x${"ab".repeat(32)}` as Hash;
const COMMIT = "https://github.com/BitGo/BitGoJS/commit/ebb4eb33fcb6621347375706770edfd435a6ec89";

const board = (token: Address): ReadinessBoard => ({
  chain: "Robinhood Chain",
  token: { contract: token, name: "Cash Cat", symbol: "CASHCAT" },
  readAt: "2026-11-19T12:00:00.000Z",
  deployed: true,
  firstMint: { at: "2026-06-30T10:00:00.000Z", block: 100, transaction: TX, to: OTHER },
  pools: [{ venue: "Uniswap v4", at: "2026-08-07T10:00:00.000Z", block: 300, transaction: TX, pairedWith: "ETH" }],
});
const sightings = (token: Address): SightingsBoard => ({ chain: "Robinhood Chain", token: { contract: token }, readAt: "2026-11-19T12:00:00.000Z", lists: [], exchanges: [], robinhood: [], unread: [] });

function filled() {
  const log = new EventLog(mkdtempSync(join(tmpdir(), "brainchain-watch-")));
  log.append([{ kind: "bitgo.merged", token: { address: CASHCAT, symbol: null, name: "Cash Cat" }, source: "BitGo", ref: COMMIT, at: "2026-07-28T07:09:00.000Z", detail: { id: "hoodeth:cashcat" }, observedAt: "2026-11-19T00:00:00.000Z", baseline: true }]);
  log.append([{ kind: "kucoin.listed", token: { address: CASHCAT, symbol: "CASHCAT", name: "Cash Cat" }, source: "KuCoin", ref: "kucoin", at: null, detail: {}, observedAt: "2026-11-19T00:00:00.000Z", baseline: true }]);
  return log;
}

const CAP: MarketCapBoard = {
  chain: "Robinhood Chain",
  token: { contract: CASHCAT, name: "Cash Cat", symbol: "CASHCAT", decimals: 18 },
  readAt: "2026-11-19T12:00:00.000Z",
  asOf: { block: 118_000_000, at: "2026-11-19T12:00:00.000Z" },
  priceUsd: "0.03825",
  supply: "1000000000",
  marketCapUsd: "38251409.00",
  swap: { block: 117_999_990, at: "2026-11-19T11:59:59.000Z", transaction: TX },
  pool: { version: "Uniswap v4", id: TX, pair: "CASHCAT/USDG", pairedWith: OTHER, fee: 3000, liquidityUsd: "1250000.00", thin: false },
  chosen: "the deepest pool",
  pools: [],
};

function context(log: EventLog, readiness: (token: Address) => Promise<ReadinessBoard> = async (token) => board(token), ms?: number, worth?: (token: Address) => Promise<MarketCapBoard>) {
  const reader = { getBlockNumber: async () => 1_000n, getTransactionReceipt: async () => ({ contractAddress: null }) } as unknown as History;
  const read: Address[] = [];
  const of = eventContext({
    log,
    wallets: [],
    times: new Map(),
    ...(ms ? { ms } : {}),
    ...(worth ? { worth } : {}),
    readers: {
      chain: (work) => work(reader),
      readiness: async (_, token) => (read.push(token), readiness(token)),
      approvals: async () => [],
      sightings: async (token) => sightings(token),
    },
  });
  return { of, read };
}

/** An event as the log holds it, numbered after every row the test log has. */
const event = (found: Found): WatchEvent => ({ id: 99, ...found, observedAt: "2026-11-19T12:00:00.000Z", context: {} });
const pool = (at: string) => event({ kind: "pool.created", token: { address: CASHCAT, symbol: "CASHCAT", name: "Cash Cat" }, source: "Uniswap v4", ref: TX, at, detail: {} });

describe("an event's context", () => {
  it("lists the token's public steps before the event, BitGo's merge from the log included, and what the log already holds", async () => {
    const { of } = context(filled());
    const extra = await of(pool("2026-08-07T10:00:00.000Z"));
    expect((extra.priorTraces as { step: string; at: string }[]).map(({ step, at }) => [step, at])).toEqual([
      ["mint", "2026-06-30T10:00:00.000Z"],
      ["custody", "2026-07-28T07:09:00.000Z"],
    ]);
    expect(extra.priorEvents).toEqual([
      { id: 1, kind: "bitgo.merged", at: "2026-07-28T07:09:00.000Z", observedAt: "2026-11-19T00:00:00.000Z", baseline: true },
      { id: 2, kind: "kucoin.listed", at: null, observedAt: "2026-11-19T00:00:00.000Z", baseline: true },
    ]);
    expect(extra.matches).toBeUndefined();
  });

  it("names the tokens a symbol could be, and reads the steps only when it names exactly one", async () => {
    const log = filled();
    const { of, read } = context(log);
    const pair = event({ kind: "robinhood.pair_added", token: { address: null, symbol: "cashcat", name: "Cash Cat" }, source: "Robinhood", ref: "pairs#CASHCAT", at: null, detail: {} });
    const one = await of(pair);
    expect(one.matches).toEqual([{ address: CASHCAT, symbol: "CASHCAT", name: "Cash Cat", kinds: ["kucoin.listed"] }]);
    expect(read).toEqual([CASHCAT]);
    expect(one.priorTraces).toHaveLength(3);
    log.append([{ kind: "lifi.listed", token: { address: OTHER, symbol: "CASHCAT", name: "Cash Cat Copy" }, source: "LI.FI", ref: "lifi", at: null, detail: {}, observedAt: "2026-11-19T00:00:00.000Z" }]);
    const two = await of(pair);
    expect((two.matches as unknown[]).length).toBe(2);
    expect(two.priorTraces).toBeUndefined();
    expect(read).toHaveLength(1);
  });

  it("goes out without the steps, saying why, when the timeline is slow or fails", async () => {
    const { of } = context(filled(), () => new Promise(() => {}), 20);
    expect(await of(pool("2026-08-07T10:00:00.000Z"))).toMatchObject({ priorTraces: null, unread: ["The token timeline was not read within 0.02 seconds."] });
  });

  it("puts BitGo's merges from the log in the form the timeline reads, one entry per commit", () => {
    const log = filled();
    log.append([{ kind: "bitgo.merged", token: { address: OTHER, symbol: null, name: "Other" }, source: "BitGo", ref: COMMIT, at: "2026-07-28T07:09:00.000Z", detail: { id: "hoodeth:other" }, observedAt: "2026-11-19T00:00:00.000Z" }]);
    expect(custodyFromLog(log).additions).toEqual([{ addedAt: "2026-07-28T07:09:00.000Z", commit: COMMIT, tokens: [{ id: "hoodeth:cashcat", name: "Cash Cat", contract: CASHCAT }, { id: "hoodeth:other", name: "Other", contract: OTHER }] }]);
  });

  it("says what the token is worth now: its market cap, price and deepest pool, as the market cap tool reads them", async () => {
    const asked: Address[] = [];
    const { of } = context(filled(), undefined, undefined, async (token) => (asked.push(token), CAP));
    const extra = await of(pool("2026-08-07T10:00:00.000Z"));
    expect(extra.worth).toEqual({ marketCapUsd: "38251409.00", priceUsd: "0.03825", supply: "1000000000", liquidityUsd: "1250000.00", thin: false, pool: { version: "Uniswap v4", id: TX, pairedWith: OTHER }, asOf: CAP.asOf });
    expect([asked, extra.worthMissing]).toEqual([[CASHCAT], undefined]);
  });

  it("says why the worth is missing: no pool, too slow, a read that failed, or no address to read", async () => {
    const reasons = async (worth: (token: Address) => Promise<MarketCapBoard>, ms?: number) => (await context(filled(), undefined, ms, worth).of(pool("2026-08-07T10:00:00.000Z"))).worthMissing;
    expect(await reasons(async () => Promise.reject(new ChainError("No pool on Uniswap v3 or v4 that pairs it with USDG, ETH or WETH traded.")))).toBe("No pool on Uniswap v3 or v4 that pairs it with USDG, ETH or WETH traded.");
    expect(await reasons(() => new Promise(() => {}), 20)).toBe("The market cap was not read within 0.02 seconds.");
    // A client library's own error can carry a node's address with its key, so it never reaches the event.
    expect(await reasons(async () => Promise.reject(new Error("HTTP request failed. URL: https://node.example/key")))).toBe("Robinhood Chain or a list could not be read just now.");
    const unnamed = await context(filled(), undefined, undefined, async () => CAP).of(event({ kind: "robinhood.page_added", token: { address: null, symbol: "NOPE", name: null }, source: "Robinhood", ref: "x", at: null, detail: {} }));
    expect([unnamed.worth, unnamed.worthMissing]).toEqual([null, "No token in the log goes by this symbol with a contract address, so its worth was not read."]);
  });

  it("tells the operator's log the cause the event does not show", async () => {
    const said: string[] = [];
    const reader = { getBlockNumber: async () => 1_000n, getTransactionReceipt: async () => ({ contractAddress: null }) } as unknown as History;
    const of = eventContext({
      log: filled(),
      wallets: [],
      times: new Map(),
      worth: async () => Promise.reject(new Error("HTTP request failed: 429")),
      say: (line) => said.push(line),
      readers: { chain: (work) => work(reader), readiness: async (_, token) => board(token), approvals: async () => [], sightings: async (token) => sightings(token) },
    });
    expect((await of(pool("2026-08-07T10:00:00.000Z"))).worthMissing).toBe("Robinhood Chain or a list could not be read just now.");
    expect(said).toEqual(["event 99: the market cap could not be read: HTTP request failed: 429"]);
  });

  it("puts a market cap board in the shape an event carries", () => {
    expect(worthOf({ ...CAP, marketCapUsd: undefined, supply: undefined }).marketCapUsd).toBeUndefined();
  });
});
