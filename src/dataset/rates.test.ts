import { describe, expect, it } from "vitest";

import type { OutcomeRow, StepRow } from "./format.js";
import { baseRates, MAX_LISTED } from "./rates.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-08-01T00:00:00Z");
const at = (days: number) => new Date(T0 + days * DAY).toISOString();
const token = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const step = (n: number, days: number, extra: Partial<StepRow> = {}): StepRow => ({ token: token(n), step: "custody", source: "BitGo", at: at(days), atFrom: "push", observedAt: at(100), ...extra });
const listed = (n: number, outcome: OutcomeRow["outcome"], when: { at?: number; by?: number }): OutcomeRow => ({
  token: token(n),
  outcome,
  venue: outcome === "kucoin" ? "KuCoin" : outcome === "gate" ? "Gate" : "Robinhood",
  ...(when.at !== undefined ? { at: at(when.at), atFrom: "source" as const } : { by: at(when.by!) }),
  match: "contract",
  ref: "x",
  observedAt: at(100),
});

describe("the base rates", () => {
  // Token 1 is listed on KuCoin 5 days after its merge, token 2 on Gate 20 days after, token 3 had KuCoin before the merge,
  // token 4 is on Robinhood's sitemap with no date, token 5 has nothing, and token 6 was merged too late for a 30-day window.
  const steps = [step(1, 0), step(2, 1), step(3, 2), step(4, 3), step(5, 4), step(6, 80)];
  const outcomes = [listed(1, "kucoin", { at: 5 }), listed(2, "gate", { at: 21 }), listed(3, "kucoin", { at: -10 }), listed(4, "robinhood_page", { by: 60 })];
  const cut = T0 + 90 * DAY;

  it("counts each window once it has passed, leaves out tokens listed before the step, and keeps an undated listing apart", () => {
    const [custody] = baseRates({ steps, outcomes, cut, kinds: ["custody"] });
    expect(custody!.n).toBe(6);
    expect(custody!.tokens).toEqual([1, 2, 3, 4, 5, 6].map(token));
    const [week, month, quarter] = custody!.windows;
    expect(week!.steps).toBe(6);
    expect(month!.steps).toBe(5);
    expect(quarter!.steps).toBe(1);
    expect(week!.outcomes.any).toMatchObject({ eligible: 5, before: 1, unknown: 1, followed: 1, share: 0.25, medianLeadDays: 5 });
    expect(month!.outcomes.any).toEqual({ eligible: 4, before: 1, unknown: 1, followed: 2, share: 0.6667, medianLeadDays: 12.5, tokens: { followed: [token(1), token(2)], unknown: [token(4)], before: [token(3)] } });
    expect(month!.outcomes.kucoin).toMatchObject({ eligible: 4, before: 1, unknown: 0, followed: 1, share: 0.25 });
    expect(month!.outcomes.gate).toMatchObject({ eligible: 5, before: 0, followed: 1 });
    expect(month!.outcomes.robinhood_page).toMatchObject({ unknown: 1, followed: 0 });
    // Only token 1's merge came 90 days before the cut-off, and it was listed within them.
    expect(quarter!.outcomes.any).toMatchObject({ eligible: 1, followed: 1, share: 1 });
  });

  it("counts only the rows public by the cut-off, so a listing dated after it is not there yet", () => {
    const [custody] = baseRates({ steps, outcomes, cut: T0 + 40 * DAY, kinds: ["custody"], windows: [30] });
    expect(custody!.n).toBe(5);
    expect(custody!.windows[0]!.outcomes.any).toMatchObject({ eligible: 4, followed: 2, unknown: 0 });
    const [early] = baseRates({ steps, outcomes, cut: T0 + 15 * DAY, kinds: ["custody"], windows: [7] });
    expect(early!.windows[0]!.outcomes.gate).toMatchObject({ followed: 0, eligible: 5 });
  });

  it("places an undated listing before a step it was on record by, and as unknown for one it was not", () => {
    const late = [step(1, 70)];
    const [custody] = baseRates({ steps: late, outcomes: [listed(1, "robinhood_tradable", { by: 60 })], cut, kinds: ["custody"], windows: [7] });
    expect(custody!.windows[0]!.outcomes.robinhood_tradable).toMatchObject({ before: 1, eligible: 0, unknown: 0, share: null });
  });

  it("takes each token's earliest dated step, and a dated row over an undated one", () => {
    const [custody] = baseRates({ steps: [step(1, 10, { at: undefined, by: at(2) }), step(1, 4), step(1, 6), step(7, 0, { at: undefined, by: at(1) })], outcomes: [listed(1, "kucoin", { at: 9 })], cut, kinds: ["custody"], windows: [7] });
    expect(custody).toMatchObject({ n: 1, undated: 1 });
    expect(custody!.windows[0]!.outcomes.kucoin).toMatchObject({ followed: 1, medianLeadDays: 5 });
  });

  it("counts every token's pool by the stretch of blocks it is in, and only once that stretch had ended", () => {
    const pools = { piece: 10, counts: [3, 2, 4], ends: [(T0 + 1 * DAY) / 1000, (T0 + 50 * DAY) / 1000, (T0 + 85 * DAY) / 1000] };
    const poolSteps = [step(1, 0.5, { step: "pool", source: "Uniswap v4", block: 5 }), step(2, 49, { step: "pool", source: "Uniswap v3", block: 15 })];
    const [pool] = baseRates({ steps: poolSteps, outcomes: [listed(1, "gate", { at: 20 }), listed(2, "kucoin", { at: 40 })], pools, cut, kinds: ["pool"], windows: [30] });
    expect(pool!.n).toBe(9);
    expect(pool!.tokens).toBeUndefined();
    expect(pool!.windows[0]!.steps).toBe(5);
    // KuCoin listed token 2 before its pool, so it is left out; Gate listed token 1 19.5 days after its pool.
    expect(pool!.windows[0]!.outcomes.any).toMatchObject({ eligible: 4, before: 1, followed: 1, share: 0.25, medianLeadDays: 19.5 });
  });

  it("keeps a share of a million pools in four significant figures, not rounded away", () => {
    const pools = { piece: 10, counts: [1_065_196], ends: [(T0 + DAY) / 1000] };
    const [pool] = baseRates({ steps: [step(1, 0.5, { step: "pool", source: "Uniswap v4", block: 5 })], outcomes: [listed(1, "kucoin", { at: 10 })], pools, cut, kinds: ["pool"], windows: [30] });
    expect(pool!.windows[0]!.outcomes.any).toMatchObject({ followed: 1, share: 9.388e-7 });
  });

  it("leaves a listing tied by the symbol alone out of every count, and says how many were left out", () => {
    const shaky: OutcomeRow = { ...listed(5, "robinhood_page", { at: 6 }), match: "symbol", unconfirmed: true };
    const [custody] = baseRates({ steps, outcomes: [...outcomes, shaky], cut, kinds: ["custody"], windows: [30] });
    expect(custody!.unconfirmed).toEqual({ rows: 1, tokens: [token(5)] });
    expect(custody!.windows[0]!.outcomes.robinhood_page).toMatchObject({ followed: 0, unknown: 1 });
    const [same] = baseRates({ steps, outcomes, cut, kinds: ["custody"], windows: [30] });
    expect({ ...custody!, unconfirmed: same!.unconfirmed }).toEqual(same);
  });

  it("names the tokens behind n only up to a limit", () => {
    const many = Array.from({ length: MAX_LISTED + 1 }, (_, i) => step(i + 1, 0));
    const [custody] = baseRates({ steps: many, outcomes: [], cut, kinds: ["custody"], windows: [7] });
    expect(custody!.n).toBe(MAX_LISTED + 1);
    expect(custody!.tokens).toBeUndefined();
  });
});
