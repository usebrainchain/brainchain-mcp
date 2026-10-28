import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { REPOST_AFTER_MINUTES } from "./config.js";

/** What the post tool tells the model about cost and settlement on the configured network. */
export interface Terms {
  /** For example "1 USDG" or "at most 2 USDG". */
  cost: string;
  /** Where the payment is taken and refunds land, for example "Robinhood Chain". */
  chain: string;
  /** How long after grading the payment or refund becomes final, for example "about six hours". */
  finalAfter: string;
}

export const POST_TASK_NAME = "brainchain_post_task";
export const GET_TASK_NAME = "brainchain_get_task";

/** Given a configuration error instead of terms, the description leads with it. */
export function postTaskTool(terms: Terms | string): Tool {
  const about =
    `Pay for a task on BrainChain. Jev, a decision model from TypeSafe, hires a frontier model for the brief, grades the result against your quality levels and pays the model only if the work reaches the second level or better. ` +
    `Briefs and results are public, so never include credentials or code that cannot be published. `;
  return {
    name: POST_TASK_NAME,
    title: "Post a paid task to BrainChain",
    description:
      typeof terms === "string"
        ? `Invalid setting: ${terms} Until then this tool only returns that error. ${about}`
        : about +
          `Each task costs ${terms.cost}, paid from this server's wallet on ${terms.chain}. The result is delivered only if Jev accepts the work. If Jev rejects the work, the full amount is refunded to the same wallet on ${terms.chain}, ${terms.finalAfter} after grading. If no model delivers within 24 hours, the full amount is refunded. ` +
          `Returns an order id for ${GET_TASK_NAME}; results usually arrive within minutes. If the reply says possiblyCharged, do not post the task again: read the order with ${GET_TASK_NAME}. ` +
          `While this server keeps running, an identical post within ${REPOST_AFTER_MINUTES} minutes returns the first post's order, marked duplicate, instead of paying again.`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120, description: "One line naming the deliverable." },
        brief: {
          type: "string",
          minLength: 1,
          maxLength: 32000,
          description: "What to produce, in what format, and anything the model must not do. Models cannot browse, so include every fact they need.",
        },
        levels: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 200 },
          minItems: 2,
          maxItems: 3,
          description:
            "Two or three quality levels, best first, each a short description a reader could check. The work is paid if it reaches the second level or better.",
        },
      },
      required: ["title", "brief", "levels"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  };
}

export const GET_TASK_TOOL: Tool = {
  name: GET_TASK_NAME,
  title: "Read a BrainChain order",
  description:
    "Read an order from brainchain_post_task: the payment, the task's status on BrainChain, Jev's grade, the result text once the work is accepted, and the refund transaction if it is not. " +
    "Call again after `retryAfterSeconds` until `done` is true. `next` says what the order's state means and what to do.",
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

const trimmed = (value: unknown, max: number) => (typeof value === "string" && value.trim().length > 0 && value.trim().length <= max ? value.trim() : undefined);

/** The desk's own limits, applied to what is sent, before anything is signed. Returns an error message, or the trimmed brief. */
export function checkBrief(input: Record<string, unknown>): TaskRequest | string {
  const title = trimmed(input.title, 120);
  if (!title) return "title must be 1 to 120 characters.";
  const brief = trimmed(input.brief, 32_000);
  if (!brief) return "brief must be 1 to 32,000 characters.";
  const levels = Array.isArray(input.levels) ? input.levels.map((l: unknown) => trimmed(l, 200)) : [];
  if (levels.length < 2 || levels.length > 3 || !levels.every((l): l is string => l !== undefined)) {
    return "levels must list 2 or 3 quality levels, best first, each 1 to 200 characters.";
  }
  return { title, brief, levels };
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

export async function callTool(desk: Desk, name: string, args: unknown): Promise<CallToolResult> {
  const input = (args ?? {}) as Record<string, unknown>;
  try {
    if (name === POST_TASK_NAME) {
      const brief = checkBrief(input);
      if (typeof brief === "string") return reply({ error: brief }, true);
      return reply(await desk.post(brief));
    }
    if (name === GET_TASK_NAME) {
      const order = typeof input.order === "string" ? input.order.trim().toLowerCase() : "";
      if (!/^0x[0-9a-f]{64}$/.test(order)) return reply({ error: "order must be the 0x-prefixed, 64-character hex id that brainchain_post_task returned." }, true);
      return orderReply(await desk.get(order));
    }
    return reply({ error: `Unknown tool ${name}.` }, true);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}
