import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import type { Bonds } from "./bonds.js";
import { formatUnits, REPOST_AFTER_MINUTES, type Config } from "./config.js";
import { canonicalStringify } from "./payments.js";
import { PREMIUMS_NAME, readPremiums, type PremiumBoard } from "./premiums.js";
import { MIN_BOND } from "./shipped.js";

/** What the post tool tells the model about cost and settlement on the configured network. */
export interface Terms {
  /** For example "1 USDG" or "at most 2 USDG". */
  cost: string;
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

/** The bond tools, worded for the network and the wallet this server holds; `closed` says why no bond can be placed. */
export function bondTools(config: Pick<Config, "maxBond" | "budget">, wallet: string | undefined, closed: string | undefined): [Tool, Tool] {
  const where = wallet ? `this server's wallet ${wallet}` : "this server's wallet";
  return [
    {
      name: BOND_TASK_NAME,
      title: "Bond a BrainChain task on Shipped",
      description:
        (closed ? `${closed} Until then this tool only returns that error. ` : "") +
        `Lock USDG on Shipped behind a BrainChain task from ${where}, as the worker that will deliver it. ` +
        `If the task is paid and its Proof is minted, the bond comes back less Shipped's 1% fee; if the task is not paid by its deadline, the bond goes to the task's poster. ` +
        `Jev reads the bond when it hires. The amount is at least the task's bounty and ${formatUnits(MIN_BOND)} USDG, at most ${formatUnits(config.maxBond)} USDG per task, and counts against this server's budget and daily limit like a post. ` +
        `The wallet needs the USDG and a little ETH on Robinhood Chain. Never bond a task this wallet posted. Returns the bond number; follow it with ${BOND_STATUS_NAME}.`,
      inputSchema: BOND_TASK_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    {
      name: BOND_STATUS_NAME,
      title: "Read this wallet's bond on a BrainChain task",
      description: `${closed ? `${closed} ` : ""}Where ${where}'s bonds on a task stand: open, marked (the Proof is recorded and the check waits out its hour), delivered (the bond less 1% is owed to the wallet) or missed (paid to the poster), with the next step.`,
      inputSchema: BOND_STATUS_INPUT,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
  ];
}

const POST_TASK_INPUT: Tool["inputSchema"] = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120, description: "One line naming the deliverable." },
    brief: {
      type: "string",
      minLength: 1,
      maxLength: 32000,
      description:
        "What to produce, in what format, and anything the model must not do. Models cannot browse, so include every fact they need. " +
        "Up to 32,000 characters, an emoji counting as two, and the whole task as JSON at most 64,000 bytes: about 21,000 characters of Chinese, Japanese or Korean.",
    },
    levels: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 200 },
      minItems: 2,
      maxItems: 3,
      uniqueItems: true,
      description:
        "Two or three different quality levels, best first, each a short description a reader could check. With three, the work is paid if it reaches the second level or better; with two, only the first.",
    },
  },
  required: ["title", "brief", "levels"],
  additionalProperties: false,
};

/** Given a configuration error instead of terms, the description leads with it. */
export function postTaskTool(terms: Terms | string): Tool {
  const about =
    `Pay for a task on BrainChain. Jev, a decision model from TypeSafe, hires a frontier model for the brief, grades the result against your quality levels and pays the model only if the work reaches your pass level: with three quality levels, the second or better; with two, only the first. ` +
    `Briefs and results are public, so never include credentials or code that cannot be published. ` +
    `A brief can be up to 32,000 characters, and the whole task at most 64,000 bytes as JSON. `;
  return {
    name: POST_TASK_NAME,
    title: "Post a paid task to BrainChain",
    description:
      typeof terms === "string"
        ? `Invalid setting: ${terms} Until then this tool only returns that error. ${about}`
        : (terms.problem ? `Invalid setting: ${terms.problem} Until the operator fixes it, this tool only returns that error. ` : "") +
          about +
          `Each task costs ${terms.cost}, paid from this server's wallet${terms.wallet ? ` ${terms.wallet}` : ""} on ${terms.chain}. The result is delivered only if Jev accepts the work. If Jev rejects the work, the full amount is refunded to the same wallet on ${terms.chain}, ${terms.finalAfter} after grading, unless the model disputes the grade and a ruling pays it. If no model delivers within 24 hours, the full amount is refunded. ` +
          `Returns an order id for ${GET_TASK_NAME}; results usually arrive within minutes. If the reply says possiblyCharged, do not post the task again: read the order with ${GET_TASK_NAME}. ` +
          `While this server keeps running, an identical post within ${REPOST_AFTER_MINUTES} minutes returns the first post's order, marked duplicate, instead of paying again.`,
    inputSchema: POST_TASK_INPUT,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };
}

const GRADE_INPUT: Tool["inputSchema"] = {
  type: "object",
  properties: {
    brief: { type: "string", minLength: 1, maxLength: 32000, description: "What the work had to do, as the worker was told. Jev knows nothing else about the job. Up to 32,000 characters, an emoji counting as two." },
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
export function gradeTool(terms: Terms | string, maxPrice: string): Tool {
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
        ? `Invalid setting: ${terms} Until then this tool only returns that error. ${about}`
        : (terms.problem ? `Invalid setting: ${terms.problem} Until the operator fixes it, this tool only returns that error. ` : "") +
          about +
          `Each grade is paid from this server's wallet${terms.wallet ? ` ${terms.wallet}` : ""} on ${terms.chain}, at most ${maxPrice} under this server's limit, and counts against its budget. ` +
          `Jev usually answers within seconds; if the reply is not done, read it with ${GET_GRADE_NAME}. If the reply says possiblyCharged, do not send it again: read it with ${GET_GRADE_NAME}. ` +
          `While this server keeps running, an identical request within ${REPOST_AFTER_MINUTES} minutes returns the first grade, marked duplicate, instead of paying again.`,
    inputSchema: GRADE_INPUT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
    "Call again after `retryAfterSeconds` until `done` is true. `next` says what the order's state means and what to do. A rejected task stays not done until the refund is sent, when the dispute window closes.",
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
  post(task: TaskRequest): Promise<unknown>;
  get(order: string): Promise<unknown>;
  grade(request: GradeRequest): Promise<unknown>;
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
  if (sent.length > max) throw new Error(`${name} is ${count(sent.length)} characters; the limit is ${count(max)}.`);
  return sent;
}

function refuseUnknownFields(input: Record<string, unknown>, schema: Tool["inputSchema"]): void {
  const known = Object.keys(schema.properties ?? {});
  const unknown = Object.keys(input).filter((key) => !known.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. This tool takes only ${known.join(", ")}.`);
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
  sent.forEach((level, i) => {
    const first = sent.indexOf(level);
    if (first < i) throw new Error(`levels[${i}] repeats levels[${first}]; each level must describe a different quality.`);
  });
  // Measured as the desk measures it: the trimmed task with its pass level, as canonical JSON.
  const bytes = Buffer.byteLength(canonicalStringify({ title, brief, levels: sent, passIndex: Math.min(1, sent.length - 2) }));
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
    levels.forEach((level, i) => {
      const first = levels.indexOf(level);
      if (first < i) throw new Error(`levels[${i}] repeats levels[${first}]; each level must describe a different quality.`);
    });
    request.levels = levels;
  }
  if (input.pass !== undefined) {
    if (!request.levels) throw new Error("pass needs levels: it is the index of the lowest passing level among them.");
    if (!Number.isInteger(input.pass) || (input.pass as number) < 0 || (input.pass as number) > request.levels.length - 2) {
      throw new Error(`pass must be a whole number from 0 to ${request.levels.length - 2}: the last level never passes.`);
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

export async function callTool(desk: Desk, name: string, args: unknown, premiums: () => Promise<PremiumBoard> = readPremiums, bonds?: Bonds): Promise<CallToolResult> {
  const input = (args ?? {}) as Record<string, unknown>;
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
      return reply(await desk.post(checkBrief(input)));
    }
    if (name === GET_TASK_NAME) {
      refuseUnknownFields(input, GET_TASK_TOOL.inputSchema);
      const order = text("order", input.order).toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(order)) throw new Error("order must be the 0x-prefixed, 64-character hex id that brainchain_post_task returned.");
      return orderReply(await desk.get(order));
    }
    if (name === GRADE_NAME) {
      refuseUnknownFields(input, GRADE_INPUT);
      return reply(await desk.grade(checkGrade(input)));
    }
    if (name === GET_GRADE_NAME) {
      refuseUnknownFields(input, GET_GRADE_TOOL.inputSchema);
      const grade = text("grade", input.grade).toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(grade)) throw new Error("grade must be the 0x-prefixed, 64-character hex id that brainchain_grade returned.");
      return reply(await desk.getGrade(grade));
    }
    if (name === PREMIUMS_NAME) return reply(await premiums());
    return reply({ error: `Unknown tool ${name}.` }, true);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}
