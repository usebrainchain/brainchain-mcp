import { describe, expect, it } from "vitest";

import { CALL_HEADER, CALL_LEVELS, callArgs, callRecord, callRequest, parseCall, settle, type IndexedCall } from "./calls.js";
import type { OutcomeRow } from "./dataset/format.js";
import type { Dataset } from "./dataset/published.js";

const CASHCAT = "0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const PONS = "0x4ab8b3b1e1b0e1a1f5c8d1fd4e38a6c0c0e1b6c1";
const MANIFEST = "de49a2b06c4ec15d5e1d8ed3ec1cb2299210d6584b488f73ee227bc3ab1c615d";

const row = (more: Partial<OutcomeRow>): OutcomeRow => ({ token: CASHCAT, outcome: "kucoin", venue: "KuCoin", match: "contract", ref: "https://www.kucoin.com/x", observedAt: "2026-11-21T00:00:00Z", ...more });

const dataset = (outcomes: OutcomeRow[] = [], readAt = "2026-11-22T00:30:00Z"): Dataset => ({
  ref: { source: "published", date: "2026-11-22", headBlock: 120_200_000, readAt, manifest: MANIFEST },
  tokens: [{ token: CASHCAT, symbol: "CASHCAT", name: "Cash Cat", sources: ["bitgo"], observedAt: "2026-07-27T00:00:00Z" }],
  steps: [{ token: CASHCAT, step: "custody", source: "BitGo", at: "2026-07-28T07:09:00Z" }],
  outcomes,
  rates: {} as Dataset["rates"],
});

const made = (more: Partial<IndexedCall> = {}): IndexedCall => ({
  token: CASHCAT,
  outcome: "any",
  days: 30,
  dataset: { date: "2026-11-22", manifest: MANIFEST },
  grade: `0x${"ab".repeat(32)}`,
  decision: "4812",
  at: "2026-11-22T12:00:00.000Z",
  payer: "0xFe4d9d7c5c530c9652A46D0BF6178b041Bc2F858",
  network: "eip155:4663",
  amount: "250000",
  accepted: true,
  record: "https://brain.usebrainchain.com/records/0xabc.json",
  ...more,
});

describe("a call's request", () => {
  it("holds the call in lines the watcher reads back, and asks Jev to judge the call, not whether it comes true", () => {
    const { call, brief, result, levels, pass, title } = callRequest(dataset(), CASHCAT, { outcome: "kucoin", days: 30 });
    expect(call).toEqual({ token: CASHCAT, outcome: "kucoin", days: 30, dataset: { date: "2026-11-22", manifest: MANIFEST } });
    expect(brief.split("\n").slice(0, 5)).toEqual([CALL_HEADER, `token: ${CASHCAT}`, "outcome: kucoin", "days: 30", `dataset: 2026-11-22 ${MANIFEST}`]);
    expect(brief).toContain("State this call as one sentence: KuCoin listing it on Robinhood Chain for Cash Cat CASHCAT");
    expect(result.split("\n")[0]).toBe(`Call: KuCoin listing it on Robinhood Chain for Cash Cat CASHCAT (${CASHCAT}) on Robinhood Chain within 30 days of this grade being recorded.`);
    expect(result).toContain(`- No outcome row for ${CASHCAT}, so the outcome was not public in the dataset.`);
    expect(result).toContain("- Dated steps: custody 2026-07-28T07:09:00.000Z.");
    expect([levels, pass, title]).toEqual([CALL_LEVELS, 0, "BrainChain call: CASHCAT, kucoin, 30 days"]);
    expect(levels.every((level) => level.length <= 200)).toBe(true);
    expect(`${brief}\n${result}`).not.toMatch(/alpha|front-?run|insider|will list|forecast|—/i);
  });

  it("is refused before anything is paid when the dataset already has the outcome", () => {
    expect(() => callRequest(dataset([row({ at: "2026-08-12T10:00:00Z" })]), CASHCAT, { outcome: "any", days: 30 })).toThrow(
      `The dataset of 2026-11-22 already has KuCoin listing it on Robinhood Chain for Cash Cat CASHCAT (${CASHCAT}), from 2026-08-12T10:00:00.000Z, so a call on it would settle as already public. Nothing was paid.`,
    );
    // Another outcome, or a row tied by the symbol alone, leaves the call open.
    expect(callRequest(dataset([row({ at: "2026-08-12T10:00:00Z" })]), CASHCAT, { outcome: "gate", days: 7 }).call.outcome).toBe("gate");
    expect(callRequest(dataset([row({ at: "2026-08-12T10:00:00Z", unconfirmed: true, match: "symbol" })]), CASHCAT, { outcome: "any", days: 7 }).result).toContain("kucoin (by symbol only, unconfirmed)");
  });

  it("names a token newer than the dataset by what its contract calls itself, and an unnamed one by its address", () => {
    expect(callRequest(dataset(), PONS, { outcome: "gate", days: 7 }, { name: "Pons\n", symbol: "PONS" }).result.split("\n")[0]).toBe(`Call: Gate listing it on Robinhood Chain for Pons PONS (${PONS}) on Robinhood Chain within 7 days of this grade being recorded.`);
    expect(callRequest(dataset(), PONS, { outcome: "gate", days: 7 }).title).toBe(`BrainChain call: ${PONS.slice(0, 10)}, gate, 7 days`);
  });

  it("takes an outcome and a number of days from the fixed choices", () => {
    expect(callArgs({})).toEqual({ outcome: "any", days: 30 });
    expect(() => callArgs({ outcome: "coinbase" })).toThrow(/^outcome must be one of any, robinhood_page/);
    expect(() => callArgs({ days: 14 })).toThrow("days must be 7, 30, 90.");
  });
});

describe("a call in a grade's brief", () => {
  it("is read back from the brief as the desk frames it, and nothing else is a call", () => {
    const { brief } = callRequest(dataset(), CASHCAT, { outcome: "bitget", days: 90 });
    const framed = `Work delivered outside BrainChain, sent in for a grade. Nobody was hired here; judge the result against the brief below.\n\nTitle: BrainChain call: CASHCAT, bitget, 90 days\n\n${brief}`;
    expect(parseCall(framed)).toEqual({ token: CASHCAT, outcome: "bitget", days: 90, dataset: { date: "2026-11-22", manifest: MANIFEST } });
    expect(parseCall("Convert an ISO 8601 duration")).toBeUndefined();
    expect(parseCall(brief.replace("days: 90", "days: 45"))).toBeUndefined();
    expect(parseCall(brief.replace(`token: ${CASHCAT}`, "token: cash cat"))).toBeUndefined();
  });
});

describe("settling a call", () => {
  it("is a hit when a confirmed outcome is dated after the call and by its deadline", () => {
    const settled = settle(made(), dataset([row({ at: "2026-12-01T09:00:00Z" })]));
    expect(settled).toMatchObject({ settled: "hit", deadline: "2026-12-22T12:00:00.000Z", by: { outcome: "kucoin", venue: "KuCoin", at: "2026-12-01T09:00:00Z" } });
  });

  it("is already public when the outcome is dated at or before the call", () => {
    expect(settle(made(), dataset([row({ at: "2026-11-22T11:59:00Z" })])).settled).toBe("already public");
    expect(settle(made({ outcome: "gate" }), dataset([row({ at: "2026-11-22T11:59:00Z" })])).settled).toBe("pending");
  });

  it("is a miss only once the dataset was read after the deadline, and pending until then", () => {
    expect(settle(made({ days: 7 }), dataset([], "2026-11-29T12:00:00Z")).settled).toBe("pending");
    expect(settle(made({ days: 7 }), dataset([], "2026-11-30T00:30:00Z")).settled).toBe("miss");
    expect(settle(made({ days: 7 }), dataset([row({ at: "2026-12-05T00:00:00Z" })], "2026-12-06T00:30:00Z")).settled).toBe("miss");
  });

  it("is settled by no row tied by the symbol alone, and says so", () => {
    const settled = settle(made(), dataset([row({ at: "2026-12-01T09:00:00Z", unconfirmed: true, match: "symbol" })]));
    expect(settled).toMatchObject({ settled: "pending", note: "A row tied by the symbol alone falls inside the window; it settles nothing until the venue confirms the token." });
  });
});

describe("a caller's record", () => {
  it("lists every call newest first and counts how each settled, with no rate", () => {
    const record = callRecord(
      made().payer,
      [made(), made({ grade: `0x${"cd".repeat(32)}`, token: PONS, at: "2026-11-23T00:00:00.000Z" }), made({ grade: `0x${"ef".repeat(32)}`, at: "2026-10-01T00:00:00.000Z", days: 7 })],
      dataset([row({ at: "2026-12-01T09:00:00Z" })], "2026-12-02T00:30:00Z"),
    );
    expect(record.calls.map((call) => call.at)).toEqual(["2026-11-23T00:00:00.000Z", "2026-11-22T12:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
    expect(record.counts).toEqual({ calls: 3, hit: 1, miss: 1, pending: 1, "already public": 0 });
    expect(JSON.stringify(record)).not.toMatch(/rate|score|percent/i);
  });
});
