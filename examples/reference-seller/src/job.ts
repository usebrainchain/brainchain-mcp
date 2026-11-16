import type { GradeRequest, Verdict } from "./judge.ts";

/** The one job this seller sells. */
export const JOB = {
  title: "A Python function that passes the buyer's tests",
  levels: [
    "Passes the tests and does everything the brief asks, correctly and completely",
    "Passes the tests and does what the brief asks, with minor gaps",
    "Fails the tests or misses what the brief asks",
  ],
  pass: 1,
};

export interface OrderRequest {
  title?: string;
  brief: string;
  /** Python that fails when the function is wrong. BrainChain runs it after the delivery, before any model grades. */
  tests: string;
  levels: string[];
  pass: number;
}

export const UNREADABLE = "Send a JSON object with brief and tests.";

/** BrainChain's own limits, checked before the worker spends any time on the order. */
export function parseOrder(body: unknown): OrderRequest | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return UNREADABLE;
  const { title, brief, tests, levels = JOB.levels, pass } = body as Record<string, unknown>;
  if (title !== undefined && (typeof title !== "string" || title.trim().length === 0 || title.length > 120)) return "title is 1 to 120 characters.";
  if (typeof brief !== "string" || brief.trim().length === 0 || brief.length > 32_000) return "brief is 1 to 32,000 characters: what the function must do.";
  if (typeof tests !== "string" || tests.trim().length === 0 || tests.length > 32_000 || tests.includes("```")) {
    return "tests is 1 to 32,000 characters of Python that fails when the function is wrong, with no ``` in it.";
  }
  const listed = Array.isArray(levels) && levels.length >= 2 && levels.length <= 5 && levels.every((l): l is string => typeof l === "string" && l.trim().length > 0 && l.length <= 200);
  if (!listed) return "levels lists 2 to 5 quality levels, best first, each up to 200 characters.";
  const lowest = pass ?? Math.min(JOB.pass, levels.length - 2);
  if (typeof lowest !== "number" || !Number.isInteger(lowest) || lowest < 0 || lowest > levels.length - 2) {
    return `pass is the index of the lowest level that passes, from 0 to ${levels.length - 2}. The last level never passes.`;
  }
  return { ...(typeof title === "string" ? { title: title.trim() } : {}), brief: brief.trim(), tests: tests.trim(), levels: levels.map((l) => l.trim()), pass: lowest };
}

/** What the worker is asked: the brief and the buyer's tests, and on a redo what went wrong with the last delivery. */
export function prompt(order: OrderRequest, last?: { delivery: string; verdict?: Verdict }): string {
  const parts = [
    "Write the Python function this brief asks for. Reply with the code in one ```python block and nothing else.",
    order.brief,
    `These tests run after your code and must pass:\n\`\`\`python\n${order.tests}\n\`\`\``,
  ];
  if (!last?.verdict) return parts.join("\n\n");
  const run = last.verdict.checks;
  const failure =
    run && run.outcome !== "passed"
      ? `The tests ${run.outcome === "timed out" ? "timed out" : "failed"}${run.error ? ` with ${run.error}` : ""}.${run.output ? `\n${run.output}` : ""}`
      : `It was judged ${Math.round(last.verdict.passProbability * 100)}% likely to pass, below the bar of ${Math.round(last.verdict.bar * 100)}%.`;
  return [...parts, `Your last delivery was not accepted. ${failure}\nIt was:\n${last.delivery}`].join("\n\n");
}

// BrainChain runs the tests after the delivery's Python code blocks, so code that arrives bare is fenced.
export function deliverable(output: string): string {
  const text = output.trim();
  if (!text) throw new Error("The worker delivered nothing.");
  return /```python\b/.test(text) ? text : `\`\`\`python\n${text}\n\`\`\``;
}

export function gradeRequest(order: OrderRequest, delivery: string): GradeRequest {
  return {
    title: order.title ?? JOB.title,
    brief: order.brief,
    levels: order.levels,
    pass: order.pass,
    result: delivery,
    checks: { language: "python", code: order.tests },
  };
}
