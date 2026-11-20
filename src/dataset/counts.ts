import type { Kind } from "../watch/events.js";
import { OUTCOMES, STEP_OF, STEP_WORDS, type Outcome, type Step } from "./format.js";
import type { Dataset } from "./published.js";

/** What an event's context says of its kind: how often earlier tokens with the same step were followed by a listing. */
export interface EventCounts {
  step: Step;
  about: string;
  dataset: { date: string; headBlock: number; manifest: string };
  n: number;
  windows: {
    days: number;
    eligible: number;
    unknown: number;
    followed: number;
    share: number | null;
    medianLeadDays: number | null;
    /** How many were listed within the window by each venue. */
    venues: Record<Outcome, number>;
  }[];
}

/** The counts the dataset gives the step an event of `kind` records, or nothing for a kind that is no step. */
export function countsFor(dataset: Dataset, kind: Kind): EventCounts | undefined {
  const step = STEP_OF[kind];
  const counts = step && dataset.rates.kinds.find((entry) => entry.step === step);
  if (!step || !counts) return undefined;
  return {
    step,
    about: STEP_WORDS[step],
    dataset: { date: dataset.ref.date, headBlock: dataset.ref.headBlock, manifest: dataset.ref.manifest },
    n: counts.n,
    windows: counts.windows.map(({ days, outcomes }) => {
      const any = outcomes.any!;
      return {
        days,
        eligible: any.eligible,
        unknown: any.unknown,
        followed: any.followed,
        share: any.share,
        medianLeadDays: any.medianLeadDays,
        venues: Object.fromEntries(OUTCOMES.map((outcome) => [outcome, outcomes[outcome]?.followed ?? 0])) as Record<Outcome, number>,
      };
    }),
  };
}

/** The counts in a few words for a chat: the 30-day window, when it has tokens whose listing can be placed. */
export function countsLine(counts: EventCounts | undefined): string {
  const month = counts?.windows.find(({ days }) => days === 30);
  const known = month ? month.eligible - month.unknown : 0;
  if (!month || known <= 0) return "";
  return ` Of ${known.toLocaleString("en-US")} earlier tokens with this step, ${month.followed.toLocaleString("en-US")} were listed by a venue within 30 days.`;
}
