import { serve } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";

import { loadSettings } from "./config.ts";
import { expressApp } from "./express.ts";
import { honoApp } from "./hono.ts";
import { createJudge } from "./judge.ts";
import { createSeller } from "./seller.ts";
import { commandWorker } from "./worker.ts";

const [framework] = process.argv.slice(2);
const dry = process.argv.includes("--dry");
if (framework !== "express" && framework !== "hono") {
  console.error("usage: node src/main.ts express|hono [--dry]");
  process.exit(1);
}
const settings = loadSettings(process.env, dry);
if (typeof settings === "string") {
  console.error(settings);
  process.exit(1);
}

const { judge: config, worker, port } = settings;
const judge = createJudge(config);
const seller = await createSeller({ dir: config.dir, judge, work: commandWorker(worker) });
if (framework === "express") expressApp(seller).listen(port);
else serve({ fetch: honoApp(seller).fetch, port });

const payer = config.key ? `paid by ${privateKeyToAccount(config.key).address} in ${config.token}` : "printed, not paid (dry run)";
console.log(`Seller on http://localhost:${port} (${framework}). Grades at ${judge.url}, ${payer}.`);
