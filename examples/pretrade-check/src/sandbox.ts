// Runs a grade request's checks on this machine the way BrainChain's sandbox does, so a mandate and its checks can
// be tried on a recorded quote before anything is paid.
import { Worker } from "node:worker_threads";

import type { GradeRequest } from "./request.ts";

export interface Run {
  outcome: "passed" | "failed" | "timed out";
  error?: string;
  output: string;
}

// The fences BrainChain runs as Python. One marked checks has more on its first line, so it never matches.
const PYTHON = /```(?:python|py|python3)[^\S\n]*\n([\s\S]*?)```/gi;

/** The one program the sandbox runs: the result's Python blocks in order, then the checks. */
export function programOf(request: Pick<GradeRequest, "result" | "checks">): string {
  const blocks = [...request.result.matchAll(PYTHON)].map((m) => m[1]!.trim()).filter(Boolean);
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
