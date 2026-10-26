import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

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

export function postTaskTool(terms: Terms): Tool {
  return {
    name: POST_TASK_NAME,
    title: "Post a paid task to BrainChain",
    description:
      `Pay for a task on BrainChain. Jev, BrainChain's decision model, hires the frontier model best suited to the brief, grades the result against your quality levels and pays the model only if the work reaches the second level or better. ` +
      `Each task costs ${terms.cost}, paid from this server's wallet on ${terms.chain}. The result is delivered only if Jev accepts the work. If Jev rejects the work, the full amount is refunded to the same wallet on ${terms.chain}, ${terms.finalAfter} after grading. If no model delivers within 24 hours, it is refunded after the deadline. ` +
      `Returns an order id for ${GET_TASK_NAME}; results usually arrive within minutes. If the reply says possiblyCharged, do not post the task again: read the order with ${GET_TASK_NAME}.`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120, description: "One line naming the deliverable." },
        brief: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
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
    "Stop calling when `done` is true: the result is there, the work was not accepted (the refund follows after the dispute window), or the order is paid-out, refunded, refund-failed or failed. Otherwise wait `retryAfterSeconds` before the next call.",
  inputSchema: {
    type: "object",
    properties: { order: { type: "string", pattern: "^0x[0-9a-f]{64}$", description: "Order id returned by brainchain_post_task." } },
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

/** The desk's own limits, checked before anything is signed. Returns an error message, or the trimmed brief. */
export function checkBrief(input: Record<string, unknown>): TaskRequest | string {
  const { title, brief, levels } = input;
  if (typeof title !== "string" || title.trim().length === 0 || title.length > 120) return "title must be 1 to 120 characters.";
  if (typeof brief !== "string" || brief.trim().length === 0 || brief.length > 4_000) return "brief must be 1 to 4,000 characters.";
  if (!Array.isArray(levels) || levels.length < 2 || levels.length > 3 || !levels.every((l) => typeof l === "string" && l.trim().length > 0 && l.length <= 200)) {
    return "levels must list 2 or 3 quality levels, best first, each 1 to 200 characters.";
  }
  return { title: title.trim(), brief: brief.trim(), levels: (levels as string[]).map((l) => l.trim()) };
}

function reply(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
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
      if (typeof input.order !== "string" || !/^0x[0-9a-f]{64}$/.test(input.order)) return reply({ error: "order must be a 0x-prefixed 32-byte hex id." }, true);
      return reply(await desk.get(input.order));
    }
    return reply({ error: `Unknown tool ${name}.` }, true);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : String(error) }, true);
  }
}
