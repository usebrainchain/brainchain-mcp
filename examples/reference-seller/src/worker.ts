import { spawn } from "node:child_process";

/** A worker that is any command: it reads the job on stdin and prints the delivery. */
export function commandWorker(command: string, timeoutMs = 10 * 60_000): (prompt: string) => Promise<string> {
  return (prompt) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, { shell: true, timeout: timeoutMs });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (code === 0) return resolve(out);
        const said = err.trim().split("\n").at(-1);
        reject(new Error(`The worker ${signal ? `was stopped by ${signal}` : `exited with ${code}`}${said ? `: ${said}` : "."}`));
      });
      child.stdin.end(prompt);
    });
}
