import { confirmed, OUTCOMES, STEPS, WINDOWS, type Outcome, type OutcomeRow, type Step, type StepRow } from "./format.js";

const DAY_MS = 86_400_000;
/** A kind with more tokens than this names them by the file that holds them, not one by one. */
export const MAX_LISTED = 2_000;

/**
 * Every token's first pool, counted by stretch of blocks: `counts[k]` tokens had their first pool in blocks k*piece to
 * (k+1)*piece - 1, and `ends[k]` is the time, in seconds, of the last block of that stretch the job read. A stretch counts
 * at a cut-off only when it had ended by then, so a pool is never counted before its block was made.
 */
export interface PoolPieces {
  piece: number;
  counts: number[];
  ends: number[];
}

/** How often a step was followed by an outcome within a window. */
export interface Count {
  /** Tokens whose step was a full window before the cut-off, less those that had the outcome before the step. */
  eligible: number;
  /** Tokens that had the outcome before the step, left out of `eligible`. */
  before: number;
  /** Eligible tokens with the outcome on record but not its date, so they cannot be placed inside or outside the window. */
  unknown: number;
  followed: number;
  /** `followed` over `eligible` less `unknown`, to four significant figures, so a share of a million pools is not 0; null when that is zero. */
  share: number | null;
  medianLeadDays: number | null;
  tokens: { followed: string[]; unknown: string[]; before: string[] };
}

export interface WindowCounts {
  days: number;
  /** Tokens whose step was at least this many days before the cut-off. */
  steps: number;
  outcomes: Partial<Record<Outcome | "any", Count>>;
}

export interface KindCounts {
  step: Step;
  /** Tokens with this step dated by the cut-off. */
  n: number;
  /** Tokens with this step on record by the cut-off but not its date. */
  undated: number;
  /** The tokens behind `n`, when there are at most `MAX_LISTED`; for pools, every token's is in `pools/`. */
  tokens?: string[];
  /**
   * Listings of these tokens that rest on a symbol alone, with nothing from the venue to confirm the token: left out of
   * every count here, and kept in the files marked `unconfirmed`.
   */
  unconfirmed: { rows: number; tokens: string[] };
  windows: WindowCounts[];
}

export interface RatesInput {
  steps: readonly StepRow[];
  outcomes: readonly OutcomeRow[];
  pools?: PoolPieces;
  /** The cut-off, in milliseconds: only rows public by then count. */
  cut: number;
  windows?: readonly number[];
  venues?: readonly Outcome[];
  kinds?: readonly Step[];
}

interface Dated {
  at: number;
  block?: number;
}

/** Each token's earliest dated row and earliest undated one, among rows public by `cut`. */
function earliest<R extends { token: string; at?: string; by?: string; block?: number }>(rows: readonly R[], cut: number) {
  const dated = new Map<string, Dated>();
  const undated = new Map<string, number>();
  for (const row of rows) {
    const token = row.token.toLowerCase();
    if (row.at !== undefined) {
      const at = Date.parse(row.at);
      if (at > cut) continue;
      const known = dated.get(token);
      if (!known || at < known.at) dated.set(token, { at, ...(row.block !== undefined ? { block: row.block } : {}) });
    } else if (row.by !== undefined) {
      const by = Date.parse(row.by);
      if (by > cut) continue;
      if (!undated.has(token) || by < undated.get(token)!) undated.set(token, by);
    }
  }
  return { dated, undated };
}

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const value = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return Math.round(value * 10) / 10;
};

type Place = { state: "before" | "unknown" | "none" } | { state: "followed" | "later"; lead: number };

/** Where one token's outcomes fall against its step at `start`, for one window. */
function place(start: number, days: number, dated: number | undefined, undated: number | undefined): Place {
  if (dated !== undefined) {
    if (dated < start) return { state: "before" };
    const lead = (dated - start) / DAY_MS;
    return { state: lead <= days ? "followed" : "later", lead };
  }
  if (undated !== undefined) return { state: undated < start ? "before" : "unknown" };
  return { state: "none" };
}

/** Of a token's outcomes, the one that settles "any venue": one before the step counts first, then the soonest that followed. */
function anyOf(places: Place[]): Place {
  if (places.some(({ state }) => state === "before")) return { state: "before" };
  const followed = places.filter((p): p is Extract<Place, { lead: number }> => p.state === "followed");
  if (followed.length) return { state: "followed", lead: Math.min(...followed.map(({ lead }) => lead)) };
  if (places.some(({ state }) => state === "unknown")) return { state: "unknown" };
  return { state: "none" };
}

/**
 * The base rates: for each kind of step, how many tokens took it and how often a venue took the token within each window
 * after. Counts only, from rows public by the cut-off: a step is counted in a window once the whole window has passed,
 * and an outcome on record without a date is counted as unknown, never as followed or not.
 */
export function baseRates({ steps, outcomes, pools, cut, windows = WINDOWS, venues = OUTCOMES, kinds = STEPS }: RatesInput): KindCounts[] {
  const counted = outcomes.filter(confirmed);
  const left = outcomes.filter((row) => !confirmed(row) && venues.includes(row.outcome) && Date.parse(row.at ?? row.by ?? "") <= cut);
  const byOutcome = new Map(venues.map((venue) => [venue, earliest(counted.filter((row) => row.outcome === venue), cut)] as const));
  const results: KindCounts[] = [];
  for (const step of kinds) {
    const { dated, undated } = earliest(steps.filter((row) => row.step === step), cut);
    for (const token of dated.keys()) undated.delete(token);
    const pieceOf = (block: number) => (pools ? Math.floor(block / pools.piece) : -1);
    const endOf = (piece: number) => (pools?.ends[piece] ?? Infinity) * 1000;
    // A pool counts once the stretch its block is in had ended; every other step once its own time had passed.
    const ready = (start: Dated, by: number) => (step === "pool" && pools && start.block !== undefined ? endOf(pieceOf(start.block)) <= by : start.at <= by);
    const n = step === "pool" && pools ? pools.counts.reduce((sum, count, k) => (endOf(k) <= cut ? sum + count : sum), 0) : dated.size;
    const unconfirmedRows = left.filter((row) => dated.has(row.token.toLowerCase()) || undated.has(row.token.toLowerCase()));
    const unconfirmed = { rows: unconfirmedRows.length, tokens: [...new Set(unconfirmedRows.map((row) => row.token.toLowerCase()))].sort() };
    const kind: KindCounts = { step, n, undated: undated.size, unconfirmed, windows: [] };
    if (step !== "pool" && dated.size <= MAX_LISTED) kind.tokens = [...dated.keys()].sort();
    for (const days of windows) {
      const by = cut - days * DAY_MS;
      const due = [...dated].filter(([, start]) => ready(start, by));
      const stepped = step === "pool" && pools ? pools.counts.reduce((sum, count, k) => (endOf(k) <= by ? sum + count : sum), 0) : due.length;
      const window: WindowCounts = { days, steps: stepped, outcomes: {} };
      const tally = (placeOf: (token: string, start: number) => Place): Count => {
        const count: Count = { eligible: 0, before: 0, unknown: 0, followed: 0, share: null, medianLeadDays: null, tokens: { followed: [], unknown: [], before: [] } };
        const leads: number[] = [];
        for (const [token, start] of due) {
          const placed = placeOf(token, start.at);
          if (placed.state === "before") count.tokens.before.push(token);
          else if (placed.state === "unknown") count.tokens.unknown.push(token);
          else if (placed.state === "followed") {
            count.tokens.followed.push(token);
            leads.push(placed.lead);
          }
        }
        count.before = count.tokens.before.length;
        count.unknown = count.tokens.unknown.length;
        count.followed = count.tokens.followed.length;
        // The pools counted by stretch include tokens no row names; only those with a row can have had an outcome first.
        count.eligible = stepped - count.before;
        const known = count.eligible - count.unknown;
        count.share = known > 0 ? Number((count.followed / known).toPrecision(4)) : null;
        count.medianLeadDays = median(leads);
        for (const list of Object.values(count.tokens)) list.sort();
        return count;
      };
      const placesOf = (token: string, start: number) =>
        venues.map((venue) => {
          const { dated: d, undated: u } = byOutcome.get(venue)!;
          return place(start, days, d.get(token)?.at, u.get(token));
        });
      window.outcomes.any = tally((token, start) => anyOf(placesOf(token, start)));
      venues.forEach((venue, i) => (window.outcomes[venue] = tally((token, start) => placesOf(token, start)[i]!)));
      kind.windows.push(window);
    }
    results.push(kind);
  }
  return results;
}
