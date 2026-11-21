import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { OutcomeRow, StepRow } from "./dataset/format.js";
import { DatasetError, type Dataset } from "./dataset/published.js";
import { TRACE_OUTCOMES_NAME, TRACE_OUTCOMES_TOOL, traceOutcomes, traceQuery } from "./outcomes.js";
import { callTool, type Desk } from "./tools.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-08-01T00:00:00Z");
const at = (days: number) => new Date(T0 + days * DAY).toISOString();
const token = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const merged = (n: number, days: number): StepRow => ({ token: token(n), step: "custody", source: "BitGo", at: at(days), atFrom: "push", observedAt: at(110) });
const kucoin = (n: number, days: number): OutcomeRow => ({ token: token(n), outcome: "kucoin", venue: "KuCoin", at: at(days), atFrom: "source", match: "contract", ref: "x", observedAt: at(110) });
const page = (n: number, days: number, match: OutcomeRow["match"] = "name"): OutcomeRow => ({ token: token(n), outcome: "robinhood_page", venue: "Robinhood", at: at(days), atFrom: "observed", match, ...(match === "symbol" ? { unconfirmed: true as const } : {}), ref: "x", observedAt: at(days) });

const DATASET: Dataset = {
  ref: { source: "local directory", date: "2026-11-20", headBlock: 119_000_000, readAt: at(111), manifest: "ab".repeat(32) },
  tokens: [],
  steps: [merged(1, 0), merged(2, 10), merged(3, 50)],
  outcomes: [kucoin(1, 9), page(2, 15), kucoin(3, 60), page(3, 55, "symbol"), page(9, 5, "symbol")],
  rates: { readAt: at(111), headBlock: 119_000_000, cut: at(110), kinds: [], pools: { piece: 10_000, counts: [], ends: [] } },
};

const desk = {} as Desk;
const body = (result: { content: unknown[] }) => JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
const call = (args: unknown, cutOf = async (moment: { time?: number }) => ({ at: moment.time! })) => callTool(desk, TRACE_OUTCOMES_NAME, args, undefined, undefined, undefined, { dataset: async () => DATASET, cutOf: cutOf as never });

describe("trace outcomes", () => {
  it("counts how often a kind of step was followed by a listing, names the dataset it read, and gives no score", async () => {
    const result = await call({ trace: "bitgo.merged" });
    expect(result.isError).toBe(false);
    const board = body(result) as { step: string; n: number; dataset: unknown; cut: unknown; windows: { days: number; outcomes: Record<string, { followed: number; tokens: { followed: string[] } }> }[] };
    expect(board).toMatchObject({ step: "custody", about: "BitGo's merge of it into its Robinhood Chain tokens", n: 3, dataset: DATASET.ref, cut: { at: at(110) } });
    expect(board.windows.map(({ days }) => days)).toEqual([7, 30, 90]);
    expect(board.windows[1]!.outcomes.any).toMatchObject({ eligible: 3, followed: 3, tokens: { followed: [token(1), token(2), token(3)] } });
    expect(board.windows[0]!.outcomes.kucoin).toMatchObject({ followed: 0 });
    // Token 3's page rests on its symbol alone: left out of the counts, and named; token 9 took no step.
    expect(board.unconfirmed).toEqual({ rows: 1, tokens: [token(3)] });
    expect(board.windows[2]!.outcomes.robinhood_page).toMatchObject({ followed: 1, tokens: { followed: [token(2)] } });
    expect(JSON.stringify(board)).not.toMatch(/score|will list|likely|predict/i);
    expect(TRACE_OUTCOMES_TOOL.description).not.toMatch(/will list|likely to|predict|—/i);
  });

  it("counts only what was public at a past time, keeps one venue or one window, and stops at what the dataset reaches", async () => {
    const past = body(await call({ trace: "custody", at: at(40), within: 30 })) as { n: number; windows: { days: number; outcomes: Record<string, { followed: number }> }[] };
    expect(past.n).toBe(2);
    expect(past.windows).toHaveLength(1);
    expect(past.windows[0]!.outcomes.any).toMatchObject({ eligible: 2, followed: 2 });
    const robinhood = body(await call({ trace: "custody", venue: "robinhood" })) as { windows: { outcomes: Record<string, unknown> }[] };
    expect(Object.keys(robinhood.windows[0]!.outcomes).sort()).toEqual(["any", "robinhood_page", "robinhood_tradable"]);
    const later = traceOutcomes(DATASET, { step: "custody" }, { at: T0 + 200 * DAY });
    expect(later.cut.at).toBe(at(110));
    expect(later.note).toMatch(/The dataset reaches .* block 119000000, so the counts stop there/);
  });

  it("refuses a kind it does not know, a window out of range, an unknown venue and both cut-offs at once", async () => {
    expect(() => traceQuery({ trace: "maker.receipt" })).toThrow(/trace must be one of/);
    expect(() => traceQuery({ trace: "custody", within: 0 })).toThrow(/within must be a whole number of days from 1 to 365/);
    expect(() => traceQuery({ trace: "custody", venue: "bitstamp" })).toThrow(/venue must be one of/);
    expect(body(await call({ trace: "custody", at: at(1), atBlock: 5 }))).toEqual({ error: "Pass atBlock or at, not both." });
    expect(body(await call({ trace: "custody", extra: 1 }))).toEqual({ error: "Unknown field: extra. This tool takes only trace, within, at, atBlock, venue." });
  });

  it("says counts appear once a dataset is published, and names the setting that points it at another", async () => {
    const result = await callTool(desk, TRACE_OUTCOMES_NAME, { trace: "pool" }, undefined, undefined, undefined, { dataset: async () => Promise.reject(new DatasetError("No dataset was published in the last 7 days at x, so there is nothing to count yet: counts appear once one is. BRAINCHAIN_DATASET points the tools at a directory or another address that holds one.")) });
    expect(result.isError).toBe(true);
    expect(body(result).error).toMatch(/counts appear once one is\. BRAINCHAIN_DATASET points/);
    expect(TRACE_OUTCOMES_TOOL.description).toContain("Counts appear once a dataset has been published there");
    expect(TRACE_OUTCOMES_TOOL.description).toContain("BRAINCHAIN_DATASET");
  });

  it("passes on why the dataset could not be read", async () => {
    const result = await callTool(desk, TRACE_OUTCOMES_NAME, { trace: "pool" }, undefined, undefined, undefined, { dataset: async () => Promise.reject(new TypeError("fetch failed")) });
    expect(body(result)).toEqual({ error: "The dataset could not be read just now: fetch failed. Try again in a minute." });
  });

  it("is in the README's tools, its table and its own section, all in plain words with no forecast", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(`- \`${TRACE_OUTCOMES_NAME}\` `);
    expect(readme.split("\n").find((line) => line.startsWith(`| \`${TRACE_OUTCOMES_NAME}\` |`))).toContain("Counts only, never a score.");
    const sections = readme.slice(readme.indexOf("## How often a step was followed by a listing"), readme.indexOf("## Watch public changes"));
    expect(sections).toContain("## The dataset");
    for (const text of [sections, TRACE_OUTCOMES_TOOL.description!]) for (const word of [/\u2014/, /alpha/i, /front-?run/i, /insider/i, /will list/i, /forecast/i, /likely/i, /predict/i]) expect(text).not.toMatch(word);
  });
});
