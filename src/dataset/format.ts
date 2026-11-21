import { createHash } from "node:crypto";

import type { Kind } from "../watch/events.js";

/**
 * The BrainChain MCP dataset: what `brainchain-mcp dataset` writes and the tools read back. Every JSONL file only grows: a
 * run appends the rows it has not written before and never changes one, so a date found later is a new row beside the
 * undated one, and a reader takes the earliest dated row of each step.
 */

/** The steps a token can take on its way to a wider market, each counted in the base rates. */
export const STEPS = ["pool", "custody_pr", "custody", "custody_release", "listing_pr", "listing", "aggregator", "approval", "pool_queued"] as const;
export type Step = (typeof STEPS)[number];

/**
 * What a step can be followed by: a venue taking the token. Bitstamp is not among them: its robots.txt closes its API to
 * automated clients, and its markets sitemap answers a script with a bot check, so nothing a daily build may read shows it.
 */
export const OUTCOMES = ["robinhood_page", "robinhood_tradable", "kucoin", "gate"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** The windows the base rates count in, in days. */
export const WINDOWS = [7, 30, 90] as const;

/**
 * Where a row's `at` comes from: a block's time; the time a repository's master branch took a push; a time the source
 * publishes itself, such as a pull request's opening or a venue's trading start; or, for a source that dates nothing, when
 * the job first saw it.
 */
export type AtFrom = "block" | "push" | "source" | "observed";

export interface MakerRef {
  name?: string;
  tag?: string;
  wallet: string;
}

/** One step of one token. A row has `at` when its time is known and `by`, a time it had happened by, when it is not. */
export interface StepRow {
  token: string;
  step: Step;
  source: string;
  at?: string;
  by?: string;
  atFrom?: AtFrom;
  block?: number;
  transaction?: string;
  ref?: string;
  pairedWith?: string;
  pool?: string;
  maker?: MakerRef;
  spender?: string;
  confirmed?: boolean;
  granted?: { at: string; block: number; transaction: string };
  id?: string;
  version?: string;
  observedAt: string;
  backfill?: true;
}

export interface OutcomeRow {
  token: string;
  outcome: Outcome;
  venue: "Robinhood" | "KuCoin" | "Gate";
  at?: string;
  by?: string;
  atFrom?: AtFrom;
  /** How the venue's entry was tied to the token: its contract on Robinhood Chain, Robinhood's name for it, or the symbol alone. */
  match: "contract" | "name" | "symbol";
  /**
   * Set on a row tied by the symbol alone, with no name or contract from the venue to confirm it: such a row is kept and
   * counted in no base rate, since a token on Robinhood Chain can call itself by another asset's symbol.
   */
  unconfirmed?: true;
  symbol?: string;
  /** The venue's own name for the asset. */
  name?: string;
  /** When the venue says trading opened, which can be after the listing was public. */
  tradingStart?: string;
  ref: string;
  observedAt: string;
  backfill?: true;
}

export interface TokenRow {
  token: string;
  symbol?: string;
  name?: string;
  /** The sources that named the token when the job first saw it. */
  sources: string[];
  observedAt: string;
  backfill?: true;
}

/** A token's first pool on one venue, kept for every token on the chain in `pools/`. Its time is its block's. */
export interface PoolRow {
  token: string;
  source: "Uniswap v3" | "Uniswap v4";
  block: number;
  pairedWith: string;
  observedAt: string;
  backfill?: true;
}

export interface SymbolRow {
  symbol: string;
  token: string;
}

export interface FileEntry {
  sha256: string;
  rows: number;
}

export interface Manifest {
  date: string;
  readAt: string;
  headBlock: number;
  files: Record<string, FileEntry>;
}

/** The files publish.mjs requires in every manifest. */
export const FILES = ["tokens.jsonl", "events.jsonl", "outcomes.jsonl", "events.csv", "outcomes.csv", "base-rates.json", "feed.json", "feed.xml"] as const;

/** `pools/` holds one file for each stretch of this many blocks, so only the newest grows. */
export const POOL_SHARD = 5_000_000;
export const poolShard = (block: number) => `pools/${String(Math.floor(block / POOL_SHARD)).padStart(3, "0")}.jsonl`;
/** `symbols/` holds a file for each of 256 buckets, by the first byte of the SHA-256 of the symbol in capitals. */
export const symbolBucket = (symbol: string) => `symbols/${createHash("sha256").update(symbol.toUpperCase()).digest("hex").slice(0, 2)}.jsonl`;

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** The watcher's kind that a step or outcome comes from, so an event's context can carry the counts for its kind. */
export const STEP_OF: Partial<Record<Kind, Step>> = {
  "pool.created": "pool",
  "maker.approval": "approval",
  "maker.pool_queued": "pool_queued",
  "bitgo.pr_opened": "custody_pr",
  "bitgo.merged": "custody",
  "bitgo.released": "custody_release",
  "trustwallet.pr_opened": "listing_pr",
  "metamask.pr_opened": "listing_pr",
  "trustwallet.merged": "listing",
  "metamask.merged": "listing",
  "lifi.listed": "aggregator",
  "coingecko.listed": "aggregator",
};

/** What each step is, in a few words, for the tools and the feed. */
export const STEP_WORDS: Record<Step, string> = {
  pool: "a first Uniswap pool",
  custody_pr: "a pull request adding it to BitGo's code",
  custody: "BitGo's merge of it into its Robinhood Chain tokens",
  custody_release: "the first @bitgo/statics release with it",
  listing_pr: "a pull request adding it to Trust Wallet's or MetaMask's list",
  listing: "Trust Wallet's or MetaMask's merge of it into their lists",
  aggregator: "LI.FI or CoinGecko listing it",
  approval: "a followed market maker wallet's first approval of it",
  pool_queued: "a market maker's multisig queuing one of its pools",
};

export const OUTCOME_WORDS: Record<Outcome, string> = {
  robinhood_page: "a page in Robinhood's crypto sitemap",
  robinhood_tradable: "a tradable pair in the list Robinhood serves to API clients",
  kucoin: "KuCoin listing it on Robinhood Chain",
  gate: "Gate listing it on Robinhood Chain",
};

/** The time a row stands for: its `at`, or for an undated row its `by`. */
export const timeOf = (row: { at?: string; by?: string }) => Date.parse(row.at ?? row.by ?? "");

/** One line of JSON per row, each ending in a newline. */
export const jsonl = (rows: readonly object[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("");

/** Rows of a JSONL text; a last line a crash cut short is not a row. */
export function parseJsonl<T>(text: string): T[] {
  const end = text.lastIndexOf("\n") + 1;
  return text
    .slice(0, end)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

const CSV_SAFE = /^[^",\n\r]*$/;
const cell = (value: unknown) => {
  if (value === undefined || value === null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // A spreadsheet reads a leading =, +, - or @ as a formula, so such a cell is quoted with a leading apostrophe.
  const safe = /^[=+\-@]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text;
  return CSV_SAFE.test(safe) ? safe : `"${safe.replace(/"/g, '""')}"`;
};

export const EVENT_COLUMNS = ["token", "step", "source", "at", "by", "atFrom", "block", "transaction", "ref", "observedAt", "backfill"] as const;
export const OUTCOME_COLUMNS = ["token", "outcome", "venue", "at", "by", "atFrom", "match", "unconfirmed", "symbol", "name", "tradingStart", "ref", "observedAt", "backfill"] as const;

export function csv(columns: readonly string[], rows: readonly object[]): string {
  const lines = rows.map((row) => columns.map((column) => cell((row as Record<string, unknown>)[column])).join(","));
  return `${columns.join(",")}\n${lines.map((line) => `${line}\n`).join("")}`;
}

/** The key a row is written once under: a later row with the same key is the same fact. */
export function stepKey(row: StepRow): string {
  const who = row.maker?.wallet.toLowerCase() ?? row.source;
  // A pull request is a step of its own each time; a queued pool is written again once its grant is on record.
  const which = row.step === "custody_pr" || row.step === "listing_pr" ? `|${row.ref ?? ""}` : row.step === "pool_queued" && row.granted ? "|granted" : "";
  return `${row.token.toLowerCase()}|${row.step}|${who}${which}|${row.at ? "at" : "by"}`;
}

/** A confirmed row is a fact of its own beside an unconfirmed one, so a match confirmed later is written too. */
export const outcomeKey = (row: OutcomeRow) => `${row.token.toLowerCase()}|${row.outcome}|${row.at ? "at" : "by"}${confirmed(row) ? "" : "|unconfirmed"}`;

/** Whether a row counts as an outcome: one tied by the symbol alone does not. */
export const confirmed = (row: Pick<OutcomeRow, "match" | "unconfirmed">) => row.unconfirmed !== true && row.match !== "symbol";

/**
 * The rows tied by the symbol alone that nothing has confirmed since: the file keeps such a row when a later build
 * confirms the match, and the confirmed row for the same token and outcome settles it.
 */
export function unsettled<T extends Pick<OutcomeRow, "token" | "outcome" | "match" | "unconfirmed">>(rows: readonly T[]): T[] {
  const key = (row: T) => `${row.token.toLowerCase()}|${row.outcome}`;
  const settled = new Set(rows.filter(confirmed).map(key));
  return rows.filter((row) => !confirmed(row) && !settled.has(key(row)));
}
