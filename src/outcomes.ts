import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { OUTCOME_WORDS, OUTCOMES, STEP_OF, STEP_WORDS, STEPS, type Outcome, type Step } from "./dataset/format.js";
import type { Dataset, DatasetRef } from "./dataset/published.js";
import { baseRates, type KindCounts } from "./dataset/rates.js";
import { KINDS, type Kind } from "./watch/events.js";

export const TRACE_OUTCOMES_NAME = "brainchain_trace_outcomes";
export const MAX_WITHIN = 365;

/** The venues a caller can keep, Robinhood standing for both of its sources. */
export const VENUES = ["robinhood", ...OUTCOMES] as const;
type Venue = (typeof VENUES)[number];
const venuesOf = (venue: Venue | undefined): readonly Outcome[] => (venue === undefined ? OUTCOMES : venue === "robinhood" ? ["robinhood_page", "robinhood_tradable"] : [venue]);

const TRACES = [...STEPS, ...KINDS.filter((kind) => STEP_OF[kind])];

export const TRACE_OUTCOMES_TOOL: Tool = {
  name: TRACE_OUTCOMES_NAME,
  title: "How often a kind of public step was followed by a listing",
  description:
    "Counts, from the BrainChain MCP dataset, of how often one kind of public step of a Robinhood Chain token was followed by a venue listing the token: of the tokens that took the step, how many were listed within 7, 30 and 90 days after it, or within `within` days. " +
    "These are counts of what happened before, with the tokens behind each: they give no score and say nothing of what happens next. A step does not say why a venue listed a token, and most tokens with any of these steps are never listed. " +
    `Pass the kind as \`trace\`: ${STEPS.map((step) => `\`${step}\` (${STEP_WORDS[step]})`).join(", ")}. A kind brainchain_changes reports, such as bitgo.merged, is taken as the step it records. ` +
    "`n` is how many tokens took the step, and `undated` how many took it with no date the source gives, which counts in no window. " +
    "Each of `windows` gives `days`, `steps`, the tokens whose step came a full window before the cut-off, and `outcomes`: `any` venue, and each one: " +
    `${OUTCOMES.map((outcome) => `\`${outcome}\` (${OUTCOME_WORDS[outcome]})`).join(", ")}. ` +
    "Each count gives `before`, the tokens the venue had listed before the step, which are left out; `eligible`, the rest; `unknown`, eligible tokens the venue lists without a date for it, which cannot be placed inside or outside the window; " +
    "`followed`, those listed within the window; `share`, `followed` over `eligible` less `unknown`; `medianLeadDays` from the step to the listing; and `tokens`, the contract addresses behind `followed`, `unknown` and `before`. " +
    "KuCoin and Gate are matched by the contract they list on Robinhood Chain and dated by the trading start each publishes. Robinhood publishes no contract and no date: it is matched by symbol, confirmed by Robinhood's own name for the asset in its pair list or on its page, and dated by when BrainChain's watcher first saw it, so a listing already there when the watcher started on November 19, 2026 counts as `before` for a step after that day and as `unknown` for one before it. " +
    "A Robinhood listing with nothing to confirm it but the symbol is left out of every count, since a token on Robinhood Chain can call itself by another asset's symbol: `unconfirmed` gives how many such rows the tokens with this step have, and `tokens`, which tokens. " +
    "Bitstamp is not counted: its robots.txt closes its API to automated clients, so the daily build does not read it; brainchain_token_sightings still reads it when asked. " +
    "A pool counts once the stretch of 10,000 blocks it was created in had ended; every token with a pool is counted, those that were never listed too. " +
    "To count only what was public at a point in the past, pass `at`, a time in ISO 8601 such as 2026-09-01T00:00:00Z, or `atBlock`: each row counts from the time its source dates it. `cut` gives the time used. " +
    "`venue` keeps one venue: robinhood (both of its sources), robinhood_page, robinhood_tradable, kucoin or gate. " +
    "`dataset` names what was read: its `date`, the `headBlock` it reaches, `readAt` and `manifest`, the SHA-256 of that day's manifest, which BrainChain inscribes on its chain; every file read is checked against the manifest first. " +
    "The dataset is built once a day by `brainchain-mcp dataset` and read from its public repository, or from the directory or address BRAINCHAIN_DATASET names. Counts appear once a dataset has been published there: until then, or while it cannot be read, the tool says so and counts nothing. Free, no key and no payment. Not advice.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      trace: { type: "string", enum: TRACES, description: "The kind of step, such as custody or bitgo.merged." },
      within: { type: "integer", minimum: 1, maximum: MAX_WITHIN, description: "Optional: one window, in days, in place of 7, 30 and 90." },
      at: { type: "string", description: "Optional: a time in ISO 8601. Only rows public by then are counted." },
      atBlock: { type: "integer", minimum: 0, description: "Optional, in place of at: a block number. Only rows public by the end of that block are counted." },
      venue: { type: "string", enum: VENUES, description: "Optional: one venue to count, in place of all four." },
    },
    required: ["trace"],
    additionalProperties: false,
  },
};

export interface TraceQuery {
  step: Step;
  within?: number;
  venue?: Venue;
}

/** The input checked, all but the cut-off, which the caller reads as every other tool's. */
export function traceQuery(input: Record<string, unknown>): TraceQuery {
  const { trace, within, venue } = input;
  if (typeof trace !== "string" || !TRACES.includes(trace as Step)) throw new Error(`trace must be one of ${STEPS.join(", ")}, or a kind brainchain_changes reports, such as bitgo.merged.`);
  const step = (STEPS as readonly string[]).includes(trace) ? (trace as Step) : STEP_OF[trace as Kind]!;
  if (within !== undefined && (typeof within !== "number" || !Number.isInteger(within) || within < 1 || within > MAX_WITHIN)) throw new Error(`within must be a whole number of days from 1 to ${MAX_WITHIN}.`);
  if (venue !== undefined && (typeof venue !== "string" || !VENUES.includes(venue as Venue))) throw new Error(`venue must be one of ${VENUES.join(", ")}.`);
  return { step, ...(within !== undefined ? { within } : {}), ...(venue !== undefined ? { venue: venue as Venue } : {}) };
}

export interface TraceBoard extends KindCounts {
  about: string;
  dataset: DatasetRef;
  cut: { at: string; block?: number };
  /** Set when the cut-off asked for is after what the dataset reaches. */
  note?: string;
}

/** The counts for one kind of step, from the rows public by `cut`, at most the dataset's own cut-off. */
export function traceOutcomes(dataset: Dataset, query: TraceQuery, cut?: { at: number; block?: number }): TraceBoard {
  const reach = Date.parse(dataset.rates.cut);
  const late = cut !== undefined && cut.at > reach;
  const at = cut && !late ? cut.at : reach;
  const [counts] = baseRates({
    steps: dataset.steps,
    outcomes: dataset.outcomes,
    pools: dataset.rates.pools,
    cut: at,
    kinds: [query.step],
    venues: venuesOf(query.venue),
    ...(query.within ? { windows: [query.within] } : {}),
  });
  return {
    about: STEP_WORDS[query.step],
    dataset: dataset.ref,
    cut: { at: new Date(at).toISOString(), ...(cut?.block !== undefined && !late ? { block: cut.block } : {}) },
    ...(late ? { note: `The dataset reaches ${dataset.rates.cut}, block ${dataset.ref.headBlock}, so the counts stop there.` } : {}),
    ...counts!,
  };
}
