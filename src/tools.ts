import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { REPOST_AFTER_MINUTES } from "./config.js";
import { canonicalStringify } from "./payments.js";
import { PREMIUMS_NAME, readPremiums, type PremiumBoard } from "./premiums.js";

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
  /** Why the key that was given cannot be used; absent when none was given. */
  keyProblem?: string;
}

export const POST_TASK_NAME = "brainchain_post_task";
/** The desk's cap on a task as it goes on chain: title, brief, levels and pass level as JSON. */
export const MAX_TASK_BYTES = 64_000;
export const GET_TASK_NAME = "brainchain_get_task";

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
        : (terms.keyProblem ? `Invalid setting: ${terms.keyProblem} Until the operator fixes it, this tool only returns that error. ` : "") +
          about +
          `Each task costs ${terms.cost}, paid from this server's wallet${terms.wallet ? ` ${terms.wallet}` : ""} on ${terms.chain}. The result is delivered only if Jev accepts the work. If Jev rejects the work, the full amount is refunded to the same wallet on ${terms.chain}, ${terms.finalAfter} after grading, unless the model disputes the grade and a ruling pays it. If no model delivers within 24 hours, the full amount is refunded. ` +
          `Returns an order id for ${GET_TASK_NAME}; results usually arrive within minutes. If the reply says possiblyCharged, do not post the task again: read the order with ${GET_TASK_NAME}. ` +
          `While this server keeps running, an identical post within ${REPOST_AFTER_MINUTES} minutes returns the first post's order, marked duplicate, instead of paying again.`,
    inputSchema: POST_TASK_INPUT,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };
}

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

export interface Desk {
  post(task: TaskRequest): Promise<unknown>;
  get(order: string): Promise<unknown>;
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

export async function callTool(desk: Desk, name: string, args: unknown, premiums: () => Promise<PremiumBoard> = readPremiums): Promise<CallToolResult> {
  const input = (args ?? {}) as Record<string, unknown>;
  try {
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
    if (name === PREMIUMS_NAME) return reply(await premiums());
    return reply({ error: `Unknown tool ${name}.` }, true);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}
