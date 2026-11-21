// Runs a grade request's checks on this machine the way BrainChain's sandbox does, so a trade is checked here before
// anything is paid for its grade, and a published decision can be run again.
import { Worker } from "node:worker_threads";

import type { GradeRequest } from "./request.ts";

export interface Run {
  outcome: "passed" | "failed" | "timed out";
  error?: string;
  output: string;
}

// As BrainChain reads them: the result's fences it runs as Python, and the brief's fence that holds the checks. A
// fence marked checks has more on its first line, so the first pattern never matches it.
export const PYTHON_FENCE = /```(?:python|py|python3)[^\S\n]*\n([\s\S]*?)```/gi;
export const CHECKS_FENCE = /```(?:python|py|python3)[^\S\n]+checks[^\S\n]*\n([\s\S]*?)```/gi;
/** The first line of any checks fence, closed or not, in either language BrainChain runs. */
export const CHECKS_OPENER = /```(?:python|py|python3|javascript|js|mjs|node)[^\S\n]+checks[^\S\n]*(?:\n|$)/gi;

/** The result's Python blocks, trimmed, as BrainChain joins them into the program. */
export const pythonBlocks = (result: string): string[] => [...result.matchAll(PYTHON_FENCE)].map((m) => m[1]!.trim()).filter(Boolean);

/** The one program the sandbox runs: the result's Python blocks in order, then the checks. */
export function programOf(request: Pick<GradeRequest, "result" | "checks">): string {
  const blocks = pythonBlocks(request.result);
  if (blocks.length === 0) throw new Error("The result has no Python block, so BrainChain would reject it without a run.");
  return `${blocks.join("\n\n")}\n\n${request.checks.code.trim()}`;
}

export async function runLocally(request: Pick<GradeRequest, "result" | "checks">, timeoutMs = 15_000): Promise<Run> {
  const code = programOf(request);
  const worker = new Worker(new URL("./sandbox-worker.mjs", import.meta.url), { env: {}, resourceLimits: { maxOldGenerationSizeMb: 256 } });
  try {
    await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    // The interpreter has loaded; as in the sandbox, the limit covers only the run.
    return await new Promise<Run>((resolve, reject) => {
      const timer = setTimeout(() => resolve({ outcome: "timed out", error: `Stopped after ${timeoutMs / 1000} seconds`, output: "" }), timeoutMs);
      worker.once("message", (run: Run) => {
        clearTimeout(timer);
        resolve(run);
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.postMessage({ code });
    });
  } finally {
    await worker.terminate();
  }
}

/** The lines a run printed for its rules, pass or FAIL, in order. */
export const ruleLines = (output: string): string[] => output.split("\n").filter((line) => line.startsWith("pass  ") || line.startsWith("FAIL  "));

/** What a run printed about the trade: its Trade line, one line per rule and the count. */
export const runLines = (output: string): string[] => output.split("\n").filter((line) => line.startsWith("Trade: ") || line.startsWith("pass  ") || line.startsWith("FAIL  ") || / of \d+ rules pass/.test(line));
