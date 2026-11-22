import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Tell the user about a change when earlier tokens with the same step were listed within WITHIN days at least
// MIN_SHARE of the time. Counts describe earlier tokens only; swap this rule for your own, or for your model's call.
const MIN_SHARE = Number(process.env.MIN_SHARE ?? 0.001);
const WITHIN = Number(process.env.WITHIN ?? 30);

interface Change {
  id: number;
  kind: string;
  token: { address: string | null; symbol: string | null; name: string | null };
  observedAt: string;
  context?: { worth?: { marketCapUsd: string; depth2pctUsd: string; thin: boolean } | null };
}

interface Counts {
  about: string;
  windows: { outcomes: { any: { eligible: number; unknown: number; followed: number; share: number | null } } }[];
}

const client = new Client({ name: "brainchain-agent-loop", version: "1.0.0" });

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text?: string }[])[0]?.text ?? "{}";
  const body = JSON.parse(text) as T & { error?: string };
  if (result.isError || body.error) throw new Error(body.error ?? text);
  return body;
}

const usd = (value: string) => Number(value).toLocaleString("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const count = (value: number) => value.toLocaleString("en-US");

async function decide(change: Change): Promise<string> {
  const token = change.token.symbol ?? change.token.name ?? change.token.address;
  const worth = change.context?.worth;
  const line = [change.observedAt, change.id, change.kind, token, worth ? `market cap ${usd(worth.marketCapUsd)}, ${usd(worth.depth2pctUsd)} depth${worth.thin ? " (thin)" : ""}` : "worth not read yet"];
  try {
    const counts = await call<Counts>("brainchain_trace_outcomes", { trace: change.kind, within: WITHIN });
    const { eligible, unknown, followed, share } = counts.windows[0]!.outcomes.any;
    const tell = share !== null && share >= MIN_SHARE;
    line.push(`after ${counts.about}, ${count(followed)} of ${count(eligible - unknown)} earlier tokens listed within ${WITHIN} days`, tell ? "tell" : "log");
  } catch (error) {
    line.push(`no counts: ${error instanceof Error ? error.message : error}`, "log");
  }
  return line.join(" | ");
}

await client.connect(new StdioClientTransport({ command: "npx", args: ["-y", "brainchain-mcp@0.22.0"] }));

// Only the kinds brainchain_trace_outcomes counts, read from its own schema so new ones are picked up.
const { tools } = await client.listTools();
const traces = (tools.find((tool) => tool.name === "brainchain_trace_outcomes")?.inputSchema.properties?.trace as { enum: string[] }).enum;
const kinds = traces.filter((trace) => trace.includes("."));

let since: number | undefined;
for (;;) {
  let behind = false;
  try {
    const page = await call<{ events: Change[]; next: number; more: boolean }>("brainchain_changes", since === undefined ? { kinds, limit: 5 } : { kinds, since });
    for (const change of page.events) console.log(await decide(change));
    behind = since !== undefined && page.more;
    since = page.next;
  } catch (error) {
    console.error(`changes not read: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
  if (process.argv.includes("--once") && !behind) break;
  if (!behind) await sleep(60_000);
}
await client.close();
