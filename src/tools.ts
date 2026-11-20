import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getAddress, isAddress, type Address } from "viem";

import type { Bonds } from "./bonds.js";
import { CHANGES_NAME, CHANGES_TOOL, changesQuery, createWatch, HOSTED_WATCH_URL, readChanges, removeWatch, UNWATCH_NAME, UNWATCH_TOOL, unwatchArgs, WATCH_NAME, WATCH_TOOL, watchArgsOf, type ChangesQuery, type WatchRequest } from "./changes.js";
import { formatUnits, REPOST_AFTER_MINUTES, type Config } from "./config.js";
import { CUSTODY_NAME, CUSTODY_TOOL, CustodyError, DAY_MS, DEFAULT_DAYS, MAX_DAYS, named, readCustodyAdditions, readListedTokens, type CustodyBoard, type CustodyToken } from "./custody.js";
import { ChainError, type Moment } from "./history.js";
import { MAKERS_NAME, MAKERS_TOOL, readMakerHoldings, type MakerBoard } from "./makers.js";
import { MARKET_CAP_NAME, MARKET_CAP_TOOL, readMarketCap, type MarketCapBoard } from "./marketcap.js";
import { brief, canonicalStringify, RESULT_LIMIT } from "./payments.js";
import { PREMIUMS_NAME, PREMIUMS_TOOL, readPremiums, type PremiumBoard } from "./premiums.js";
import { READINESS_NAME, READINESS_TOOL, readTokenReadiness, type ReadinessBoard } from "./readiness.js";
import { MIN_BOND, MISSED_TO } from "./shipped.js";
import { readTokenSightings, SIGHTINGS_NAME, SIGHTINGS_TOOL, SightingsError, type SightingsBoard } from "./sightings.js";
import { readTokenTimeline, TIMELINE_NAME, TIMELINE_TOOL, type TimelineBoard } from "./timeline.js";

/** What the post tool tells the model about cost and settlement on the configured network. */
export interface Terms {
  /** For example "1 USDG", or "at most 2 USDG" under a raised BRAINCHAIN_MAX_PRICE_UNITS. */
  cost: string;
  /** The same for a grade, for example "0.25 USDG". */
  gradeCost: string;
  /** Set when BRAINCHAIN_MAX_PRICE_UNITS is under the desk's price: why posts, and grades if their price is above it too, are refused. */
  refuses?: { task?: string; grade?: string };
  /** Where the payment is taken and refunds land, for example "Robinhood Chain". */
  chain: string;
  /** How long after grading the payment or refund becomes final, for example "about six hours". */
  finalAfter: string;
  /** The paying wallet's address, so an agent can check its balance without going near the key. */
  wallet?: string;
  /** A setting that keeps this tool from paying, such as a key given that cannot be used; absent when there is none. */
  problem?: string;
}

export const POST_TASK_NAME = "brainchain_post_task";
/** The desk's cap on a task as it goes on chain: title, brief, levels and pass level as JSON. */
export const MAX_TASK_BYTES = 64_000;
export const GET_TASK_NAME = "brainchain_get_task";
export const BOND_TASK_NAME = "brainchain_bond_task";
export const BOND_STATUS_NAME = "brainchain_bond_status";
export const GRADE_NAME = "brainchain_grade";
export const GET_GRADE_NAME = "brainchain_get_grade";
/** The desk's cap on a delivered result sent for a grade. */
export const MAX_RESULT_BYTES = 100_000;

/** What a length in UTF-16 units, which the desk counts in, means to someone writing a brief. */
const UNITS = "most characters take one, an emoji two or more";

const TASK_ID = { type: "string", pattern: "^[1-9][0-9]{0,17}$", description: "The task's id on BrainChain's task board." } as const;
const BOND_TASK_INPUT: Tool["inputSchema"] = {
  type: "object",
  properties: {
    task: TASK_ID,
    amount: { type: "string", pattern: "^[0-9]{1,9}(\\.[0-9]{1,6})?$", description: "USDG to lock, such as \"5\" or \"2.5\": at least the task's bounty and at least 2 USDG." },
  },
  required: ["task", "amount"],
  additionalProperties: false,
};
const BOND_STATUS_INPUT: Tool["inputSchema"] = { type: "object", properties: { task: TASK_ID }, required: ["task"], additionalProperties: false };

/** How a tool leads its description while a setting the operator must fix stops it. */
export const invalidSetting = (problem: string) => `Invalid setting: ${problem} Until the operator fixes it, this tool only returns that error. `;

/**
 * The bond tools, worded for the network and the wallet this server holds. `closed` says why bonds do not run
 * on this network, and `invalid`, per tool, the setting that stops it: reading a bond needs less than placing
 * one, so the two can differ. Without settings to read, the cap is named by its variable.
 */
export function bondTools(
  config: Partial<Pick<Config, "maxBond">>,
  wallet: string | undefined,
  { closed, invalid = {} }: { closed?: string; invalid?: { bond?: string; status?: string } } = {},
): [Tool, Tool] {
  const where = wallet ? `this server's wallet ${wallet}` : "this server's wallet";
  const lead = (problem: string | undefined) => (problem ? invalidSetting(problem) : closed ? `${closed} On this network this tool only returns that error. ` : "");
  const cap = config.maxBond === undefined ? "BRAINCHAIN_MAX_BOND_UNITS" : `${formatUnits(config.maxBond)} USDG`;
  return [
    {
      name: BOND_TASK_NAME,
      title: "Bond a BrainChain task on Shipped",
      description:
        lead(invalid.bond) +
        `Lock USDG on Shipped behind a BrainChain task from ${where}, as the worker that will deliver it. Jev must already have hired this wallet for the task. ` +
        `If the task is paid and its Proof is recorded by the bond's deadline, which is set after the task's and comes back in the reply, the bond less Shipped's 1% fee is credited to the wallet on Shipped's registry, where the worker CLI's \`bond claim\` collects it; if not, the bond goes to ${MISSED_TO}. ` +
        `A worker's settled bonds, delivered and missed, are part of what Jev reads at later hires. ` +
        `The amount is at least the task's bounty and ${formatUnits(MIN_BOND)} USDG, at most ${cap} per task, and counts against this server's budget and daily limit like a post. ` +
        `The wallet needs the USDG and a little ETH on Robinhood Chain. Never bond a task this wallet posted or paid for. Returns the bond, its transaction and its deadline; follow it with ${BOND_STATUS_NAME}. ` +
        `If the reply says possiblyBonded, the bond may have been placed and could not be confirmed: read the task with ${BOND_STATUS_NAME} and do not bond it again.`,
      inputSchema: BOND_TASK_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    {
      name: BOND_STATUS_NAME,
      title: "Read this wallet's bond on a BrainChain task",
      description:
        lead(invalid.status) +
        `Where ${where}'s bonds on a task stand: open, marked (the Proof is recorded and the check waits out its hour), ` +
        `lapsed (the bond's deadline passed with its check unmarked, so the bond waits to settle as missed), ` +
        `delivered (the bond less Shipped's 1% fee was credited to the wallet on Shipped's registry; the reply says whether it was collected or what the registry still owes the wallet) ` +
        `or missed (paid to ${MISSED_TO}), with the next step.`,
      inputSchema: BOND_STATUS_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
  ];
}

const POST_TASK_INPUT: Tool["inputSchema"] = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120, description: "One line naming the deliverable, up to 120 UTF-16 units." },
    brief: {
      type: "string",
      minLength: 1,
      maxLength: 32000,
      description:
        "What to produce, in what format, and anything the model must not do. Models cannot browse, so include every fact they need. " +
        `Up to 32,000 UTF-16 units, as the desk counts: ${UNITS} (a flag four, a family emoji eleven). The whole task as JSON is at most 64,000 bytes: about 21,000 characters of Chinese, Japanese or Korean.`,
    },
    levels: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 200 },
      minItems: 2,
      maxItems: 3,
      uniqueItems: true,
      description:
        "Two or three different quality levels, best first, each a short description a reader could check, up to 200 UTF-16 units. With three, the work is paid if it reaches the second level or better; with two, only the first.",
    },
    passIndex: {
      type: "integer",
      enum: [0, 1],
      description: "Leave this out: the tool sets the pass level itself. A brief copied with it is accepted only when it names that level, 1 with three levels and 0 with two.",
    },
  },
  required: ["title", "brief", "levels"],
  additionalProperties: false,
};

/** Given a configuration error instead of terms, the description leads with it. */
export function postTaskTool(terms: Terms | string): Tool {
  const about =
    `Pay for a task on BrainChain. Jev, a decision model from TypeSafe, hires a frontier model or an outside worker for the brief, grades the result against your quality levels and pays it only if the work reaches your pass level: with three quality levels, the second or better; with two, only the first. ` +
    `Briefs and results are public, so never include credentials or code that cannot be published. ` +
    `A brief can be up to 32,000 UTF-16 units (${UNITS}), and the whole task at most 64,000 bytes as JSON. `;
  return {
    name: POST_TASK_NAME,
    title: "Post a paid task to BrainChain",
    description:
      typeof terms === "string"
        ? `${invalidSetting(terms)}${about}`
        : (terms.problem ? invalidSetting(terms.problem) : "") +
          about +
          `Each task costs ${terms.cost}, paid from this server's wallet${terms.wallet ? ` ${terms.wallet}` : ""} on ${terms.chain}. ${terms.refuses?.task ? `${terms.refuses.task} ` : ""}The result is delivered only if Jev accepts the work. If Jev rejects the work, the full amount is refunded to the same wallet on ${terms.chain}, ${terms.finalAfter} after grading, unless the model disputes the grade and a ruling pays it. If no model delivers within 24 hours, the full amount is refunded. ` +
          `Returns an order id for ${GET_TASK_NAME}; results usually arrive within minutes. If the reply says possiblyCharged, do not post the task again: read the order with ${GET_TASK_NAME}. ` +
          `While this server keeps running, an identical post within ${REPOST_AFTER_MINUTES} minutes returns the first post's order, marked duplicate, instead of paying again, unless ${GET_TASK_NAME} has read that order's payment as failed.`,
    inputSchema: POST_TASK_INPUT,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };
}

const GRADE_INPUT: Tool["inputSchema"] = {
  type: "object",
  properties: {
    brief: { type: "string", minLength: 1, maxLength: 32000, description: `What the work had to do, as the worker was told. Jev knows nothing else about the job. Up to 32,000 UTF-16 units: ${UNITS}.` },
    result: { type: "string", minLength: 1, description: "The delivered work as text, at most 100,000 bytes." },
    title: { type: "string", minLength: 1, maxLength: 120, description: "Optional: one line naming the job." },
    levels: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 200 },
      minItems: 2,
      maxItems: 5,
      uniqueItems: true,
      description: "Optional: two to five quality levels of your own, best first. Without them Jev uses three general levels.",
    },
    pass: { type: "integer", minimum: 0, maximum: 3, description: "Optional, with levels: the index of the lowest level that passes, 0 being the best. The last level never passes." },
  },
  required: ["brief", "result"],
  additionalProperties: false,
};

/** Grading work delivered elsewhere: a market whose poster approves the work can read Jev's verdict first. */
export function gradeTool(terms: Terms | string): Tool {
  const about =
    `Have Jev grade work delivered somewhere else, such as a job on another agent market, against the brief it answered. ` +
    `Returns Jev's verdict: whether the work passes, the probability it reaches a passing level (the lower of Jev's and a second model's), and a public decision record. ` +
    `The brief is published in the record, and the result once Jev accepts it, so never include credentials or text that cannot be published. ` +
    `This tool only grades: nothing is paid to the worker and no task is posted. `;
  return {
    name: GRADE_NAME,
    title: "Grade delivered work on BrainChain",
    description:
      typeof terms === "string"
        ? `${invalidSetting(terms)}${about}`
        : (terms.problem ? invalidSetting(terms.problem) : "") +
          about +
          `Each grade costs ${terms.gradeCost} whatever the verdict, paid from this server's wallet${terms.wallet ? ` ${terms.wallet}` : ""} on ${terms.chain}, and counts against its budget and daily limit. ` +
          (terms.refuses?.grade ? `${terms.refuses.grade} ` : "") +
          `Jev usually answers within seconds; if the reply is not done, read it with ${GET_GRADE_NAME}. If the reply says possiblyCharged, do not send it again: read it with ${GET_GRADE_NAME}. ` +
          `While this server keeps running, an identical request within ${REPOST_AFTER_MINUTES} minutes returns the first grade, marked duplicate, instead of paying again.`,
    inputSchema: GRADE_INPUT,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };
}

export const GET_GRADE_TOOL: Tool = {
  name: GET_GRADE_NAME,
  title: "Read a BrainChain grade",
  description: "Read a grade from brainchain_grade: Jev's verdict, the pass probability, each level's probability and the decision record. Free, no key. Call again after `retryAfterSeconds` until `done` is true.",
  inputSchema: {
    type: "object",
    properties: { grade: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$", description: "Grade id returned by brainchain_grade." } },
    required: ["grade"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

export const GET_TASK_TOOL: Tool = {
  name: GET_TASK_NAME,
  title: "Read a BrainChain order",
  description:
    "Read an order from brainchain_post_task: the payment, the task's status on BrainChain, Jev's grade, the result text once the work is accepted, and the refund transaction if it is not. " +
    `A result over ${RESULT_LIMIT.toLocaleString("en-US")} UTF-16 units (${UNITS}) is cut there, ending with a link to the full text. ` +
    "Call again after `retryAfterSeconds` until `done` is true. `next` says what the order's state means and what to do. A rejected task stays not done until the refund is sent, when the dispute window closes. Two things end it without a refund transaction: a ruling that pays the model, and a refund the desk gives up sending, when `state` reads `refund-failed` and `next` says who to write to.",
  inputSchema: {
    type: "object",
    properties: { order: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$", description: "Order id returned by brainchain_post_task." } },
    required: ["order"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

export interface TaskRequest {
  title: string;
  brief: string;
  levels: string[];
}

/** Work delivered somewhere else, sent for Jev's verdict against the brief it answered. */
export interface GradeRequest {
  title?: string;
  brief: string;
  result: string;
  levels?: string[];
  pass?: number;
}

export interface Desk {
  /** `signal` is the MCP call's: a call cancelled before the payment is signed pays nothing. */
  post(task: TaskRequest, signal?: AbortSignal): Promise<unknown>;
  get(order: string): Promise<unknown>;
  grade(request: GradeRequest, signal?: AbortSignal): Promise<unknown>;
  getGrade(id: string): Promise<unknown>;
}

const typeName = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "object" ? "an object" : `a ${typeof value}`);
const count = (n: number) => n.toLocaleString("en-US");

/**
 * Text that shows nothing: whitespace, control and format characters, line and
 * paragraph separators, and the default-ignorable and blank letters that have
 * no Unicode property of their own.
 */
const BLANK = /^[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\ufe00-\ufe0f\uffa0\u{e0000}-\u{e0fff}]*$/u;

/** A string field as it is sent, trimmed; throws what is wrong with it. Lengths count UTF-16 units, as the desk does. */
function text(name: string, value: unknown, max = Infinity): string {
  if (value === undefined) throw new Error(`${name} is required.`);
  if (typeof value !== "string") throw new Error(`${name} must be a string, not ${typeName(value)}.`);
  const sent = value.trim();
  if (BLANK.test(sent)) throw new Error(`${name} is empty.`);
  if (sent.length > max) throw new Error(`${name} is ${count(sent.length)} UTF-16 units; the limit is ${count(max)}. Most characters take one, an emoji two or more.`);
  return sent;
}

/** Levels that differ only in case or spacing describe the same quality. */
function distinct(levels: string[]): void {
  const folded = levels.map((level) => level.toLowerCase());
  folded.forEach((level, i) => {
    const first = folded.indexOf(level);
    if (first < i) throw new Error(`levels[${i}] repeats levels[${first}]; each level must describe a different quality.`);
  });
}

/** An address as viem writes it. One in capitals and small letters carries a checksum, which catches a mistyped character. */
function address(name: string, value: unknown): Address {
  const sent = text(name, value);
  if (!/^0x[0-9a-fA-F]{40}$/.test(sent)) throw new Error(`${name} must be an address on Robinhood Chain: 0x followed by 40 hex characters.`);
  // An address with no small letters carries no checksum, as one with no capitals does.
  const plain = /[a-f]/.test(sent) ? sent : sent.toLowerCase();
  if (!isAddress(plain)) {
    throw new Error(`The capital and small letters in ${name} do not match its checksum, which usually means a character was mistyped. Compare it with the source you copied it from. If the two match, send the address in lowercase.`);
  }
  return getAddress(plain);
}

/** A symbol several of BitGo's tokens go by: the answer names them and reads nothing more. */
class Candidates extends Error {
  constructor(
    message: string,
    readonly candidates: CustodyToken[],
  ) {
    super(message);
  }
}

/** How a symbol was looked up, as the answer reports it. */
export interface Lookup {
  asked: string;
  id: string;
  name?: string;
  contract: Address;
}

/**
 * The token `value` names: an address, checked as one, or a symbol or name, looked up on BitGo's lists. Anything that
 * starts like an address is read as one, so a mistyped address is never taken for a symbol.
 */
async function tokenOf(value: unknown, listed: Readers["listed"]): Promise<{ token: Address; lookup?: Lookup }> {
  const sent = text("token", value);
  if (/^0x/i.test(sent) || /^[0-9a-fA-F]{40}$/.test(sent)) return { token: address("token", sent) };
  if (sent.length > 80 || /[\n\r\u2028\u2029]/.test(sent)) throw new Error("token must be a contract address on Robinhood Chain, or a symbol or name of one line and at most 80 characters.");
  const tokens = await listed().catch((error: unknown) => {
    if (error instanceof CustodyError) throw error;
    throw new Error(`BitGo's code on GitHub could not be read just now to look up the symbol: ${brief(error)} Pass the token's contract address, or try again in a minute.`);
  });
  const found = named(tokens, sent);
  const contracts = new Set(found.map(({ contract }) => contract));
  if (found.length === 0) throw new Error(`No token on BitGo's lists for Robinhood Chain has the id or name ${JSON.stringify(sent)}. Pass the token's contract address instead.`);
  if (contracts.size > 1) throw new Candidates(`${found.length} tokens on BitGo's lists for Robinhood Chain go by ${JSON.stringify(sent)}, so nothing was read. Pass the contract address of the one you mean, from \`candidates\`.`, found);
  const [{ id, name, contract }] = found as [CustodyToken];
  if (!contract) throw new Error(`BitGo lists ${id} in a form this tool does not read, so it has no contract address for it. Pass the token's contract address instead.`);
  return { token: contract, lookup: { asked: sent, id, ...(name ? { name } : {}), contract } };
}

/** A time in ISO 8601: a date, which is midnight UTC, or a date and time with its offset. Without one, a time would be read in the server's own zone. */
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

/** A time in the past, in milliseconds. A date such as February 30 is refused, which `Date.parse` would move to March. */
function instant(name: string, value: unknown, now = Date.now()): number {
  const sent = text(name, value);
  const [, year, month, day] = ISO_TIME.exec(sent) ?? [];
  const time = Date.parse(sent);
  if (!year || Number.isNaN(time) || new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDate() !== Number(day)) {
    throw new Error(`${name} must be a time in ISO 8601, such as 2026-11-01T00:00:00Z, or a date, such as 2026-11-01.`);
  }
  if (time > now) throw new Error(`${name} is in the future.`);
  return time;
}

/** The past block a read is for, from `atBlock` or `at`; undefined for a read of the newest block. */
function moment(input: Record<string, unknown>): Moment | undefined {
  if (input.atBlock !== undefined && input.at !== undefined) throw new Error("Pass atBlock or at, not both.");
  if (input.atBlock !== undefined) {
    if (typeof input.atBlock !== "number" || !Number.isSafeInteger(input.atBlock) || input.atBlock < 0) throw new Error("atBlock must be a block number: a whole number from 0.");
    return { block: BigInt(input.atBlock) };
  }
  return input.at === undefined ? undefined : { time: instant("at", input.at) };
}

function refuseUnknownFields(input: Record<string, unknown>, schema: Tool["inputSchema"]): void {
  const known = Object.keys(schema.properties ?? {});
  const unknown = Object.keys(input).filter((key) => !known.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. This tool takes ${known.length > 0 ? `only ${known.join(", ")}` : "nothing"}.`);
}

/**
 * The desk's own limits, applied to what is sent, before anything is signed,
 * plus what this tool's description promises: a title of one line and levels
 * that differ. Returns the trimmed brief; throws what is wrong with it.
 */
export function checkBrief(input: Record<string, unknown>): TaskRequest {
  const title = text("title", input.title, 120);
  if (/[\n\r\u2028\u2029]/.test(title)) throw new Error("title must be one line.");
  const brief = text("brief", input.brief, 32_000);
  const { levels } = input;
  if (levels === undefined) throw new Error("levels is required.");
  if (!Array.isArray(levels)) throw new Error(`levels must be an array of strings, not ${typeName(levels)}.`);
  if (levels.length < 2 || levels.length > 3) throw new Error(`levels must list 2 or 3 quality levels, best first; this lists ${levels.length}.`);
  const sent = levels.map((level: unknown, i) => text(`levels[${i}]`, level, 200));
  distinct(sent);
  // The desk sets the pass level itself: the lowest level never passes. A copied brief that names the same level is the same brief.
  const passIndex = Math.min(1, sent.length - 2);
  if (input.passIndex !== undefined && input.passIndex !== passIndex) {
    throw new Error(`passIndex must be ${passIndex} here: with ${sent.length === 3 ? "three levels this tool pays work that reaches the second level or better" : "two levels this tool pays only work that reaches the first"}. Leave passIndex out.`);
  }
  // Measured as the desk measures it: the trimmed task with its pass level, as canonical JSON.
  const bytes = Buffer.byteLength(canonicalStringify({ title, brief, levels: sent, passIndex }));
  if (bytes > MAX_TASK_BYTES) {
    throw new Error(`The task is ${count(bytes)} bytes as JSON; the limit is ${count(MAX_TASK_BYTES)}. Shorten the brief.`);
  }
  return { title, brief, levels: sent };
}

/** The desk's limits on a grade request, checked before anything is signed. */
export function checkGrade(input: Record<string, unknown>): GradeRequest {
  const brief = text("brief", input.brief, 32_000);
  if (input.result === undefined) throw new Error("result is required.");
  if (typeof input.result !== "string") throw new Error(`result must be a string, not ${typeName(input.result)}.`);
  const result = input.result;
  if (BLANK.test(result.trim())) throw new Error("result is empty.");
  const bytes = Buffer.byteLength(result);
  if (bytes > MAX_RESULT_BYTES) throw new Error(`result is ${count(bytes)} bytes; the limit is ${count(MAX_RESULT_BYTES)}.`);
  const request: GradeRequest = { brief, result };
  if (input.title !== undefined) {
    const title = text("title", input.title, 120);
    if (/[\n\r\u2028\u2029]/.test(title)) throw new Error("title must be one line.");
    request.title = title;
  }
  if (input.levels !== undefined) {
    if (!Array.isArray(input.levels)) throw new Error(`levels must be an array of strings, not ${typeName(input.levels)}.`);
    if (input.levels.length < 2 || input.levels.length > 5) throw new Error(`levels must list 2 to 5 quality levels, best first; this lists ${input.levels.length}.`);
    const levels = input.levels.map((level: unknown, i) => text(`levels[${i}]`, level, 200));
    distinct(levels);
    request.levels = levels;
  }
  if (input.pass !== undefined) {
    if (!request.levels) throw new Error("pass needs levels: it is the index of the lowest passing level among them.");
    const highest = request.levels.length - 2;
    if (!Number.isInteger(input.pass) || (input.pass as number) < 0 || (input.pass as number) > highest) {
      throw new Error(highest === 0 ? "pass must be 0 with two levels: the last level never passes." : `pass must be a whole number from 0 to ${highest}: the last level never passes.`);
    }
    request.pass = input.pass as number;
  }
  return request;
}

function reply(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

/** The result text goes out as its own block, as written, rather than escaped inside the JSON. */
function orderReply(view: unknown): CallToolResult {
  const { resultText, ...rest } = view as Record<string, unknown>;
  const result = reply(rest);
  if (typeof resultText === "string") result.content.push({ type: "text", text: resultText });
  return result;
}

/** How the tools that read public sources get their answers. A test passes its own in place of any of them. */
export interface Readers {
  /** `period` is a number of days back, or the time the period starts. */
  custody(period: number | Date): Promise<CustodyBoard>;
  makers(token: Address, wallet?: Address, moment?: Moment): Promise<MakerBoard>;
  readiness(token: Address): Promise<ReadinessBoard>;
  sightings(token: Address, until?: Moment): Promise<SightingsBoard>;
  /** BitGo's tokens on Robinhood Chain, which a symbol is looked up in. */
  listed(): Promise<CustodyToken[]>;
  timeline(token: Address, until?: Moment): Promise<TimelineBoard>;
  marketCap(token: Address, moment?: Moment): Promise<MarketCapBoard>;
  /** The events of the watcher BRAINCHAIN_WATCH_URL names, or of BrainChain's own. */
  changes(query: ChangesQuery): Promise<unknown>;
  watch(request: WatchRequest): Promise<unknown>;
  unwatch(id: string, manageToken: string): Promise<unknown>;
}

const READERS: Readers = {
  custody: readCustodyAdditions,
  makers: readMakerHoldings,
  readiness: readTokenReadiness,
  sightings: readTokenSightings,
  listed: readListedTokens,
  timeline: readTokenTimeline,
  marketCap: readMarketCap,
  changes: (query) => readChanges(new URL(HOSTED_WATCH_URL), query),
  watch: (request) => createWatch(new URL(HOSTED_WATCH_URL), request),
  unwatch: (id, manageToken) => removeWatch(new URL(HOSTED_WATCH_URL), id, manageToken),
};

/** An answer for a token looked up by symbol leads with what it was looked up as. */
const withLookup = (board: object, lookup: Lookup | undefined) => (lookup ? { lookup, ...board } : board);

/** `refused` names the tools that a setting keeps from running, each with the error it answers whatever it is sent. */
export async function callTool(
  desk: Desk,
  name: string,
  args: unknown,
  premiums: () => Promise<PremiumBoard> = readPremiums,
  bonds?: Bonds,
  refused: ReadonlyMap<string, string> = new Map(),
  readers: Partial<Readers> = {},
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const { custody, makers, readiness, sightings, listed, timeline, marketCap, changes, watch, unwatch } = { ...READERS, ...readers };
  const input = (args ?? {}) as Record<string, unknown>;
  const refusal = refused.get(name);
  if (refusal !== undefined) return reply({ error: refusal }, true);
  try {
    if (name === BOND_TASK_NAME || name === BOND_STATUS_NAME) {
      if (!bonds) return reply({ error: "This server has no bond tools." }, true);
      refuseUnknownFields(input, name === BOND_TASK_NAME ? BOND_TASK_INPUT : BOND_STATUS_INPUT);
      const task = text("task", input.task);
      if (!/^[1-9]\d{0,17}$/.test(task)) throw new Error("task must be the task's id on BrainChain, a whole number above zero.");
      if (name === BOND_STATUS_NAME) return reply(await bonds.status(BigInt(task)));
      const amount = text("amount", input.amount);
      if (!/^\d{1,9}(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) throw new Error("amount is in USDG, above zero with at most 6 decimals, such as \"5\".");
      const [whole, fraction = ""] = amount.split(".");
      return reply(await bonds.bond(BigInt(task), BigInt(whole! + fraction.padEnd(6, "0"))));
    }
    if (name === POST_TASK_NAME) {
      refuseUnknownFields(input, POST_TASK_INPUT);
      return reply(await desk.post(checkBrief(input), signal));
    }
    if (name === GET_TASK_NAME) {
      refuseUnknownFields(input, GET_TASK_TOOL.inputSchema);
      const order = text("order", input.order).toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(order)) throw new Error("order must be the 0x-prefixed, 64-character hex id that brainchain_post_task returned.");
      return orderReply(await desk.get(order));
    }
    if (name === GRADE_NAME) {
      refuseUnknownFields(input, GRADE_INPUT);
      return reply(await desk.grade(checkGrade(input), signal));
    }
    if (name === GET_GRADE_NAME) {
      refuseUnknownFields(input, GET_GRADE_TOOL.inputSchema);
      const grade = text("grade", input.grade).toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(grade)) throw new Error("grade must be the 0x-prefixed, 64-character hex id that brainchain_grade returned.");
      return reply(await desk.getGrade(grade));
    }
    if (name === PREMIUMS_NAME) {
      refuseUnknownFields(input, PREMIUMS_TOOL.inputSchema);
      const board = await premiums().catch((error: unknown) => {
        throw new Error(`Robinhood Chain could not be read just now: ${brief(error)} Try again in a minute.`);
      });
      return reply(board);
    }
    if (name === CUSTODY_NAME) {
      refuseUnknownFields(input, CUSTODY_TOOL.inputSchema);
      const days = input.days === undefined ? DEFAULT_DAYS : input.days;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`days must be a whole number from 1 to ${MAX_DAYS}. Leave it out to look back ${DEFAULT_DAYS} days.`);
      const now = Date.now();
      const since = input.since === undefined ? undefined : instant("since", input.since, now);
      if (since !== undefined && since < now - MAX_DAYS * DAY_MS) throw new Error(`since can be at most ${MAX_DAYS} days back, as far as this tool reads BitGo's changes.`);
      const board = await custody(since === undefined ? days : new Date(since)).catch((error: unknown) => {
        if (error instanceof CustodyError) throw error;
        throw new Error(`BitGo's code on GitHub could not be read just now: ${brief(error)} Try again in a minute.`);
      });
      return reply(board);
    }
    if (name === MAKERS_NAME) {
      refuseUnknownFields(input, MAKERS_TOOL.inputSchema);
      const wallet = input.wallet === undefined ? undefined : address("wallet", input.wallet);
      const when = moment(input);
      const { token, lookup } = await tokenOf(input.token, listed);
      const board = await makers(token, wallet, when).catch((error: unknown) => {
        if (error instanceof ChainError) throw error;
        throw new Error(`Robinhood Chain could not be read just now: ${brief(error)} Try again in a minute.`);
      });
      return reply(withLookup(board, lookup));
    }
    if (name === READINESS_NAME) {
      refuseUnknownFields(input, READINESS_TOOL.inputSchema);
      const { token, lookup } = await tokenOf(input.token, listed);
      const board = await readiness(token).catch((error: unknown) => {
        if (error instanceof ChainError) throw error;
        throw new Error(`Robinhood Chain could not be read just now: ${brief(error)} Try again in a minute.`);
      });
      return reply(withLookup(board, lookup));
    }
    if (name === SIGHTINGS_NAME) {
      refuseUnknownFields(input, SIGHTINGS_TOOL.inputSchema);
      const when = moment(input);
      const { token, lookup } = await tokenOf(input.token, listed);
      const board = await sightings(token, when).catch((error: unknown) => {
        if (error instanceof SightingsError || error instanceof ChainError) throw error;
        throw new Error(`The lists could not be read just now: ${brief(error)} Try again in a minute.`);
      });
      return reply(withLookup(board, lookup));
    }
    if (name === TIMELINE_NAME) {
      refuseUnknownFields(input, TIMELINE_TOOL.inputSchema);
      const when = moment(input);
      const { token, lookup } = await tokenOf(input.token, listed);
      const board = await timeline(token, when).catch((error: unknown) => {
        if (error instanceof ChainError) throw error;
        throw new Error(`Robinhood Chain could not be read just now: ${brief(error)} Try again in a minute.`);
      });
      return reply(withLookup(board, lookup));
    }
    if (name === MARKET_CAP_NAME) {
      refuseUnknownFields(input, MARKET_CAP_TOOL.inputSchema);
      const when = moment(input);
      const { token, lookup } = await tokenOf(input.token, listed);
      const board = await marketCap(token, when).catch((error: unknown) => {
        if (error instanceof ChainError) throw error;
        throw new Error(`Robinhood Chain could not be read just now: ${brief(error)} Try again in a minute.`);
      });
      return reply(withLookup(board, lookup));
    }
    if (name === CHANGES_NAME) {
      refuseUnknownFields(input, CHANGES_TOOL.inputSchema);
      return reply(await changes(changesQuery(input)));
    }
    if (name === WATCH_NAME) {
      refuseUnknownFields(input, WATCH_TOOL.inputSchema);
      return reply(await watch(watchArgsOf(input)));
    }
    if (name === UNWATCH_NAME) {
      refuseUnknownFields(input, UNWATCH_TOOL.inputSchema);
      const { id, manageToken } = unwatchArgs(input);
      return reply(await unwatch(id, manageToken));
    }
    return reply({ error: `Unknown tool ${name}.` }, true);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error), ...(error instanceof Candidates ? { candidates: error.candidates } : {}) }, true);
  }
}
