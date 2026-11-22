import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { OUTCOME_WORDS, OUTCOMES, timeOf, type Outcome, type OutcomeRow } from "./dataset/format.js";
import type { Dataset, DatasetRef } from "./dataset/published.js";

export const CALL_NAME = "brainchain_call";
export const CALLS_NAME = "brainchain_calls";

/** The first line of every call's brief: the watcher keeps the grades whose brief has it, and only those. */
export const CALL_HEADER = "BrainChain call, version 1.";
export const CALL_OUTCOMES = ["any", ...OUTCOMES] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export const CALL_DAYS = [7, 30, 90] as const;
const DAY_MS = 86_400_000;

export const CALL_LEVELS = [
  "Names the token, the outcome and the deadline in one sentence",
  "Leaves out the token, the outcome or the deadline",
];

export interface Call {
  token: string;
  outcome: CallOutcome;
  days: number;
  /** The day of the dataset the call was checked against, and its manifest's SHA-256. */
  dataset: { date: string; manifest: string };
}

/** A call as the watcher found it on BrainChain's DecisionLog: the grade that holds it, who paid and when it was recorded. */
export interface IndexedCall extends Call {
  grade: string;
  decision: string;
  /** When the grade was recorded on BrainChain; the deadline counts from here. */
  at: string;
  payer: string;
  network: string;
  amount: string;
  /** Whether Jev accepted the call as complete, at the board's grade bar. A call counts either way. */
  accepted: boolean;
  record: string;
}

const outcomeWords = (outcome: CallOutcome) => (outcome === "any" ? "a listing at any venue the dataset reads" : OUTCOME_WORDS[outcome as Outcome]);

/** The rows that settle a call: the token's outcome rows of the called kind, any kind for `any`. */
const settling = (token: string, outcome: CallOutcome, rows: readonly OutcomeRow[]) => rows.filter((row) => row.token.toLowerCase() === token.toLowerCase() && (outcome === "any" || row.outcome === outcome));

export function callArgs(input: Record<string, unknown>): Pick<Call, "outcome" | "days"> {
  const outcome = input.outcome ?? "any";
  if (typeof outcome !== "string" || !(CALL_OUTCOMES as readonly string[]).includes(outcome)) throw new Error(`outcome must be one of ${CALL_OUTCOMES.join(", ")}.`);
  const days = input.days ?? 30;
  if (typeof days !== "number" || !(CALL_DAYS as readonly number[]).includes(days)) throw new Error(`days must be ${CALL_DAYS.join(", ")}.`);
  return { outcome: outcome as CallOutcome, days };
}

/**
 * The grade request that makes a call: the brief holds the call in lines the watcher reads back, the result the dataset's
 * facts about the token. Refused before anything is paid when the dataset already has the outcome.
 */
export function callRequest(
  dataset: Dataset,
  token: string,
  { outcome, days }: Pick<Call, "outcome" | "days">,
  /** What the contract calls itself, for a token newer than the dataset. */
  onChain?: { name?: string; symbol?: string },
): { title: string; brief: string; result: string; levels: string[]; pass: number; call: Call } {
  const known = dataset.tokens.find((row) => row.token.toLowerCase() === token.toLowerCase()) ?? onChain;
  const clean = (text?: string) => text?.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trim().slice(0, 40) || undefined;
  const [name, symbol] = [clean(known?.name), clean(known?.symbol)];
  const named = [name, symbol && symbol !== name ? symbol : undefined].filter(Boolean).join(" ");
  const label = named ? `${named} (${token})` : token;
  const rows = dataset.outcomes.filter((row) => row.token.toLowerCase() === token.toLowerCase());
  const already = settling(token, outcome, rows).filter((row) => !row.unconfirmed);
  if (already.length) {
    const first = already.sort((a, b) => timeOf(a) - timeOf(b))[0]!;
    throw new Error(`The dataset of ${dataset.ref.date} already has ${OUTCOME_WORDS[first.outcome]} for ${label}, from ${new Date(timeOf(first)).toISOString()}, so a call on it would settle as already public. Nothing was paid.`);
  }
  const call: Call = { token, outcome, days, dataset: { date: dataset.ref.date, manifest: dataset.ref.manifest } };
  const steps = dataset.steps.filter((step) => step.token.toLowerCase() === token.toLowerCase()).sort((a, b) => timeOf(a) - timeOf(b));
  const statement = `${outcomeWords(outcome)} for ${label} on Robinhood Chain within ${days} days of this grade being recorded`;
  const brief = [
    CALL_HEADER,
    `token: ${token}`,
    `outcome: ${outcome}`,
    `days: ${days}`,
    `dataset: ${dataset.ref.date} ${dataset.ref.manifest}`,
    "",
    `State this call as one sentence: ${statement}. Add, as context, what the BrainChain MCP dataset of ${dataset.ref.date} holds for the token.`,
  ].join("\n");
  const result = [
    `Call: ${statement}.`,
    "",
    `Facts from the BrainChain MCP dataset of ${dataset.ref.date} (manifest ${dataset.ref.manifest}, through block ${dataset.ref.headBlock}):`,
    rows.length
      ? `- Outcome rows for ${token}: ${rows.map((row) => `${row.outcome}${row.unconfirmed ? " (by symbol only, unconfirmed)" : ""} at ${new Date(timeOf(row)).toISOString()}`).join("; ")}. None is ${outcome === "any" ? "a confirmed listing" : `a confirmed ${outcome} row`}, so the outcome was not public in the dataset.`
      : `- No outcome row for ${token}, so the outcome was not public in the dataset.`,
    steps.length ? `- Dated steps: ${steps.map((step) => `${step.step} ${new Date(timeOf(step)).toISOString()}`).join("; ")}.` : "- No dated step for the token yet.",
  ].join("\n");
  return { title: `BrainChain call: ${symbol ?? token.slice(0, 10)}, ${outcome}, ${days} days`, brief, result, levels: CALL_LEVELS, pass: 0, call };
}

/** The call in a grade's brief, or nothing when the brief holds none or a malformed one. */
export function parseCall(text: string): Call | undefined {
  const start = text.indexOf(CALL_HEADER);
  if (start < 0) return undefined;
  const fields = new Map<string, string>();
  for (const line of text.slice(start + CALL_HEADER.length).split("\n").slice(1)) {
    const field = /^(token|outcome|days|dataset): (.+)$/.exec(line.trim());
    if (!field) break;
    fields.set(field[1]!, field[2]!);
  }
  const token = fields.get("token") ?? "";
  const outcome = fields.get("outcome") ?? "";
  const days = Number(fields.get("days"));
  const dataset = /^(\d{4}-\d{2}-\d{2}) ([0-9a-f]{64})$/.exec(fields.get("dataset") ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !(CALL_OUTCOMES as readonly string[]).includes(outcome) || !(CALL_DAYS as readonly number[]).includes(days) || !dataset) return undefined;
  return { token, outcome: outcome as CallOutcome, days, dataset: { date: dataset[1]!, manifest: dataset[2]! } };
}

export type Settled = "hit" | "miss" | "pending" | "already public";

export interface SettledCall extends IndexedCall {
  deadline: string;
  settled: Settled;
  /** The outcome row that settled it as a hit or as already public. */
  by?: Pick<OutcomeRow, "outcome" | "venue" | "at" | "by" | "ref">;
  note?: string;
}

/**
 * How the published dataset settles a call: a hit when a confirmed outcome row is dated after the call was recorded and
 * by its deadline; already public when one is dated at or before; a miss once the deadline has passed and the dataset was
 * read after it; pending until then. A row tied by the symbol alone settles nothing.
 */
export function settle(call: IndexedCall, dataset: Pick<Dataset, "outcomes"> & { ref: Pick<DatasetRef, "readAt"> }): SettledCall {
  const at = Date.parse(call.at);
  const deadline = at + call.days * DAY_MS;
  const rows = settling(call.token, call.outcome, dataset.outcomes).sort((a, b) => timeOf(a) - timeOf(b));
  const confirmed = rows.filter((row) => !row.unconfirmed);
  const shown = (row: OutcomeRow) => ({ outcome: row.outcome, venue: row.venue, ...(row.at ? { at: row.at } : {}), ...(row.by ? { by: row.by } : {}), ref: row.ref });
  const base = { ...call, deadline: new Date(deadline).toISOString() };
  const early = confirmed.find((row) => timeOf(row) <= at);
  if (early) return { ...base, settled: "already public", by: shown(early) };
  const hit = confirmed.find((row) => timeOf(row) > at && timeOf(row) <= deadline);
  if (hit) return { ...base, settled: "hit", by: shown(hit) };
  const unconfirmed = rows.some((row) => row.unconfirmed && timeOf(row) <= deadline) ? { note: "A row tied by the symbol alone falls inside the window; it settles nothing until the venue confirms the token." } : {};
  if (Date.parse(dataset.ref.readAt) > deadline) return { ...base, settled: "miss", ...unconfirmed };
  return { ...base, settled: "pending", ...unconfirmed };
}

export const CALL_COLUMNS = ["decision", "grade", "at", "payer", "token", "outcome", "days", "deadline", "accepted", "settled", "settledOutcome", "settledVenue", "settledAt", "settledRef", "note", "network", "amount", "datasetDate", "datasetManifest", "record"] as const;

/** A settled call as one flat row of `calls.csv`: the outcome row that settled it and the dataset it was checked against, spread into columns. */
export function callCells({ by, dataset, ...call }: SettledCall) {
  return { ...call, settledOutcome: by?.outcome, settledVenue: by?.venue, settledAt: by?.at ?? by?.by, settledRef: by?.ref, datasetDate: dataset.date, datasetManifest: dataset.manifest };
}

/** A caller's calls as the dataset settles them, newest first, with how many settled each way: counts, never a rate. */
export function callRecord(caller: string, calls: readonly IndexedCall[], dataset: Dataset): { caller: string; dataset: DatasetRef; counts: Record<"calls" | "hit" | "miss" | "pending" | "already public", number>; calls: SettledCall[] } {
  const settled = calls.map((call) => settle(call, dataset)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const counts = { calls: settled.length, hit: 0, miss: 0, pending: 0, "already public": 0 };
  for (const call of settled) counts[call.settled]++;
  return { caller, dataset: dataset.ref, counts, calls: settled };
}

const OUTCOME_LIST = CALL_OUTCOMES.join(", ");

export const CALL_TOOL: Tool = {
  name: CALL_NAME,
  title: "Make a public, graded call on a Robinhood Chain token",
  description:
    "Records your agent's call that a Robinhood Chain token reaches an outcome within 7, 30 or 90 days: a listing at any venue the dataset reads, or one of them. " +
    "The call is a paid grade on BrainChain: this server's wallet pays the grade's price, Jev checks that the call names the token, the outcome and the deadline, and the call is recorded on BrainChain's DecisionLog with the wallet that paid. " +
    `Nothing is paid when the published dataset already has the outcome. Each call counts in brainchain_calls for that wallet once made, hit or miss: a call cannot be withdrawn or left out. ` +
    "The published dataset settles it: a hit when the outcome is dated after the call and by its deadline, a miss once the deadline has passed. " +
    `Returns the call, its deadline and the grade, as brainchain_grade returns it.`,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      token: { type: "string", minLength: 1, description: "The token's contract address on Robinhood Chain, or its symbol or name." },
      outcome: { type: "string", enum: [...CALL_OUTCOMES], description: `What the call says happens: any (a listing at any venue the dataset reads) or one of ${OUTCOME_LIST.replace("any, ", "")}. Default any.` },
      days: { type: "integer", enum: [...CALL_DAYS], description: "Within how many days of the call. Default 30." },
    },
    required: ["token"],
    additionalProperties: false,
  },
};

export const CALLS_TOOL: Tool = {
  name: CALLS_NAME,
  title: "Read a wallet's calls and how they settled",
  description:
    "Lists every call a wallet made with brainchain_call, newest first, each settled by the newest published dataset: hit, miss, pending or already public, with the outcome row that settled it and the decision record. " +
    "Counts how many settled each way. Every call the wallet paid for is in it, because the watcher reads them from BrainChain's DecisionLog, not from what the caller sends. Free, no key.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: { caller: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "The wallet that paid for the calls: the payer of each call's grade." } },
    required: ["caller"],
    additionalProperties: false,
  },
};
