// One run per worker, set up as BrainChain's sandbox sets up its Python: Pyodide with stdout and stderr captured
// and capped, and the JavaScript network APIs removed before the code runs.
import { parentPort } from "node:worker_threads";

import { loadPyodide } from "pyodide";

const LIMIT = 4000;
let output = "";
const write = (text) => {
  if (output.length < LIMIT) output += text.slice(0, LIMIT - output.length);
};

const pyodide = await loadPyodide({ stdout: (line) => write(`${line}\n`), stderr: (line) => write(`${line}\n`) });
for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) delete globalThis[name];

parentPort.postMessage({ ready: true });
parentPort.once("message", async ({ code }) => {
  try {
    await pyodide.runPythonAsync(code);
    parentPort.postMessage({ outcome: "passed", output });
  } catch (error) {
    const traceback = String(error?.message ?? error).trim();
    const last = traceback.split("\n").filter(Boolean).at(-1) ?? "error";
    parentPort.postMessage({ outcome: "failed", error: last.slice(0, 500), output: `${output}${traceback}`.slice(-LIMIT) });
  }
});
