import { access, readFile, rm, writeFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The watcher shows a watch's manage token only once, and --remove needs it, so it is kept here, readable by you alone.
const SAVED = ".watch.json";

const client = new Client({ name: "brainchain-discord-watch", version: "1.0.0" });

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, string>> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text?: string }[])[0]?.text ?? "{}";
  const body = JSON.parse(text) as Record<string, string>;
  if (result.isError || body.error) throw new Error(body.error ?? text);
  return body;
}

const list = (name: string) => process.env[name]?.split(",").map((item) => item.trim()).filter(Boolean);

async function watch(): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error("Set DISCORD_WEBHOOK_URL to the channel's webhook URL: in Discord, Edit Channel > Integrations > Webhooks > Copy Webhook URL.");
  if (await access(SAVED).then(() => true, () => false)) throw new Error(`${SAVED} already holds a watch. Remove it first with npm run discord -- --remove.`);
  const kinds = list("KINDS");
  const tokens = list("TOKENS");
  const made = await call("brainchain_watch", { url, ...(kinds && { kinds }), ...(tokens && { tokens }) });
  await writeFile(SAVED, `${JSON.stringify({ watcher: made.watcher, id: made.id, manageToken: made.manageToken }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Watch ${made.id} made on ${made.watcher}. Each new change now goes to the channel as one line.`);
  console.log("Stop it with npm run discord -- --remove.");
}

async function remove(): Promise<void> {
  const saved = await readFile(SAVED, "utf8").catch(() => undefined);
  if (!saved) throw new Error(`${SAVED} holds no watch, so there is none to remove.`);
  const { id, manageToken } = JSON.parse(saved) as Record<string, string>;
  await call("brainchain_unwatch", { id, manageToken });
  await rm(SAVED);
  console.log(`Watch ${id} removed. Nothing more goes to the channel.`);
}

try {
  await client.connect(new StdioClientTransport({ command: "npx", args: ["-y", "brainchain-mcp@0.22.0"] }));
  await (process.argv.includes("--remove") ? remove() : watch());
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.close();
}
