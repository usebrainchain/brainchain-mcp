import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventLog, kindMatches, knownKind, type Found } from "./events.js";

const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const dir = () => mkdtempSync(join(tmpdir(), "brainchain-watch-"));
const found = (more: Partial<Found> = {}): Found => ({
  kind: "bitgo.merged",
  token: { address: CASHCAT, symbol: null, name: "Cash Cat" },
  source: "BitGo",
  ref: "https://github.com/BitGo/BitGoJS/commit/ebb4eb33fcb6621347375706770edfd435a6ec89",
  at: "2026-07-28T07:09:00.000Z",
  detail: { id: "hoodeth:cashcat" },
  ...more,
});
const at = (observedAt: string, row: Found) => ({ ...row, observedAt });

describe("the event log", () => {
  it("numbers events from 1, keeps one per kind, token and ref, and writes each as a line", () => {
    const where = dir();
    const log = new EventLog(where);
    const [first] = log.append([at("2026-11-19T10:00:00.000Z", found())]);
    expect(first).toMatchObject({ id: 1, kind: "bitgo.merged", context: {} });
    // Another case of the same address is the same token.
    expect(log.append([at("2026-11-19T10:01:00.000Z", found({ token: { address: CASHCAT.toLowerCase(), symbol: null, name: null } }))])).toEqual([]);
    const [second] = log.append([at("2026-11-19T10:02:00.000Z", found({ kind: "bitgo.pr_opened", ref: "https://github.com/BitGo/BitGoJS/pull/9357" }))]);
    expect(second!.id).toBe(2);
    // Two rows of one write that are the same event are one.
    expect(log.append([at("2026-11-19T10:03:00.000Z", found({ ref: "x" })), at("2026-11-19T10:03:00.000Z", found({ ref: "x" }))])).toHaveLength(1);
    log.close();
    const lines = readFileSync(join(where, "events.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as { id: number }).id)).toEqual([1, 2, 3]);
  });

  it("tells tokens apart by address, then BitGo's id, then symbol", () => {
    const log = new EventLog(dir());
    const robinhood = (symbol: string) => found({ kind: "robinhood.pair_added", token: { address: null, symbol, name: null }, ref: "pairs", detail: {} });
    const noContract = (id: string) => found({ token: { address: null, symbol: null, name: "Same name" }, detail: { id } });
    expect(log.append([at("2026-11-19T10:00:00Z", robinhood("CASHCAT")), at("2026-11-19T10:00:00Z", robinhood("cashcat"))])).toHaveLength(1);
    expect(log.append([at("2026-11-19T10:00:00Z", noContract("hoodeth:a")), at("2026-11-19T10:00:00Z", noContract("hoodeth:b"))])).toHaveLength(2);
  });

  it("opens again where it left off, dropping a line a crash cut short", () => {
    const where = dir();
    const log = new EventLog(where);
    log.append([at("2026-11-19T10:00:00Z", found()), { ...at("2026-11-19T10:00:00Z", found({ ref: "b" })), baseline: true }]);
    log.close();
    appendFileSync(join(where, "events.jsonl"), '{"id":3,"kind":"bitgo.mer');
    const again = new EventLog(where);
    expect([again.size, again.lastId, again.baselineSize]).toEqual([2, 2, 1]);
    expect(again.has(found())).toBe(true);
    expect(again.append([at("2026-11-19T11:00:00Z", found({ ref: "c" }))])[0]!.id).toBe(3);
    again.close();
    expect(readFileSync(join(where, "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
  });

  describe("asked for events", () => {
    const filled = () => {
      const log = new EventLog(dir());
      log.append([{ ...at("2026-11-19T09:00:00.000Z", found({ ref: "old" })), baseline: true }]);
      log.append([at("2026-11-19T10:00:00.000Z", found({ kind: "bitgo.pr_opened", ref: "pr" }))]);
      log.append([at("2026-11-19T11:00:00.000Z", found({ kind: "pool.created", ref: "0xabc", source: "Uniswap v4", detail: {} }))]);
      log.append([at("2026-11-19T12:00:00.000Z", found({ kind: "robinhood.pair_added", token: { address: null, symbol: "PONS", name: "Pons" }, ref: "pairs#PONS", detail: {} }))]);
      return log;
    };

    it("leaves the baseline out unless asked, and gives the newest without a since", () => {
      const log = filled();
      expect(log.query().events.map(({ id }) => id)).toEqual([2, 3, 4]);
      expect(log.query({ baseline: true }).events.map(({ id }) => id)).toEqual([1, 2, 3, 4]);
      expect(log.query({ limit: 2 })).toMatchObject({ next: 4, more: true });
      expect(log.query({ limit: 2 }).events.map(({ id }) => id)).toEqual([3, 4]);
    });

    it("goes on from an id or a time, and hands back where to go on from", () => {
      const log = filled();
      expect(log.query({ since: { id: 2 }, limit: 1 })).toMatchObject({ next: 3, more: true });
      expect(log.query({ since: { id: 4 } })).toEqual({ events: [], next: 4, more: false });
      // A cursor past the end stays where it is, so a log that is reset is noticed rather than read twice.
      expect(log.query({ since: { id: 9 } }).next).toBe(9);
      expect(log.query({ since: { time: Date.parse("2026-11-19T11:00:00Z") } }).events.map(({ id }) => id)).toEqual([3, 4]);
    });

    it("keeps kinds by name or by source, and tokens by address, symbol or BitGo id", () => {
      const log = filled();
      expect(log.query({ kinds: ["bitgo"] }).events.map(({ id }) => id)).toEqual([2]);
      expect(log.query({ kinds: ["bitgo.*", "pool.created"] }).events.map(({ id }) => id)).toEqual([2, 3]);
      expect(log.query({ tokens: [CASHCAT.toLowerCase()] }).events.map(({ id }) => id)).toEqual([2, 3]);
      expect(log.query({ tokens: ["$pons"] }).events.map(({ id }) => id)).toEqual([4]);
      expect(log.query({ tokens: ["cashcat"] }).events.map(({ id }) => id)).toEqual([2]);
    });
  });

  it("knows its kinds and their sources", () => {
    expect(kindMatches("bitgo.merged", "bitgo")).toBe(true);
    expect(kindMatches("bitgo.merged", "bit")).toBe(false);
    expect([knownKind("robinhood"), knownKind("maker.receipt"), knownKind("binance")]).toEqual([true, true, false]);
  });
});
