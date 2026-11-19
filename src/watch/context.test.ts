import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAddress, type Address, type Hash } from "viem";
import { describe, expect, it } from "vitest";

import type { ChainHistory } from "../history.js";
import type { ReadinessBoard } from "../readiness.js";
import type { SightingsBoard } from "../sightings.js";
import { custodyFromLog, eventContext } from "./context.js";
import { EventLog, type Found } from "./events.js";

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

function context(log: EventLog, readiness: (token: Address) => Promise<ReadinessBoard> = async (token) => board(token), ms?: number) {
  const reader = { getBlockNumber: async () => 1_000n, getTransactionReceipt: async () => ({ contractAddress: null }) } as unknown as ChainHistory;
  const read: Address[] = [];
  const of = eventContext({
    log,
    wallets: [],
    times: new Map(),
    ...(ms ? { ms } : {}),
    readers: {
      chain: (work) => work(reader),
      readiness: async (_, token) => (read.push(token), readiness(token)),
      approvals: async () => [],
      sightings: async (token) => sightings(token),
    },
  });
  return { of, read };
}

const pool = (at: string): Found => ({ kind: "pool.created", token: { address: CASHCAT, symbol: "CASHCAT", name: "Cash Cat" }, source: "Uniswap v4", ref: TX, at, detail: {} });

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
    const pair: Found = { kind: "robinhood.pair_added", token: { address: null, symbol: "cashcat", name: "Cash Cat" }, source: "Robinhood", ref: "pairs#CASHCAT", at: null, detail: {} };
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
});
