import { join } from "node:path";

import { watchUrl } from "../changes.js";
import { expandHome } from "../config.js";
import { configuredMakers, MARKET_MAKERS } from "../makers.js";
import { ROBINHOOD_RPC } from "../premiums.js";
import { githubToken } from "../watch/cli.js";
import { Requests } from "../watch/http.js";
import { chainReader, privateReader, redactor, RPC_SETTING, rpcSetting } from "../watch/rpc.js";
import { lockStateDir } from "../watch/state.js";
import { buildDataset, STATE_DIR } from "./build.js";
import { batchedReader } from "./chain.js";
import { poolDir, poolWatcher } from "./sources.js";

export const DATASET_USAGE = `Usage: brainchain-mcp dataset --out <dir> [--pools <dir>]

Builds the BrainChain MCP dataset in <dir>: every Robinhood Chain token with a pool or a public trace, the dated public
steps each took, the venues that went on to list it, and how often each kind of step was followed by a listing within 7,
30 and 90 days. It writes tokens.jsonl, events.jsonl, outcomes.jsonl, their CSV copies, base-rates.json, feed.json,
feed.xml, calls.jsonl and calls.csv (every call made with brainchain_call, settled by the day's outcomes), pools/
(every token's first pool on each Uniswap venue), symbols/ (what each of those tokens calls itself) and
manifests/YYYY-MM-DD.json, with the SHA-256 and rows of each file.

Keep <dir> between builds: each build adds the rows it has not written before and never changes one, and goes on from
where the last one stopped. The first build reads the chain's whole history, which takes more than one build's 50
minutes: until a build has read the chain through its newest block, it exits 2, and running it again goes on. Later
builds take minutes.

  --out <dir>    Where the dataset is built and kept.
  --pools <dir>  Read the pool index from the state folder of a brainchain-mcp watch on this machine, in place of the
                 watcher's GET /pools?after=.

Environment: BRAINCHAIN_WATCH_URL names the watcher whose log, pool index and calls the build reads (default
https://watch.usebrainchain.com). BRAINCHAIN_WATCH_RPC reads Robinhood Chain from another RPC, such as Chainstack, with
the public endpoint as the fallback; without it the chain's history is read from the public endpoint alone, which is
slow. GITHUB_TOKEN, or GITHUB_TOKEN_FILE, dates Trust Wallet's and MetaMask's files with that token's allowance; without
one a build dates 40 of them. BRAINCHAIN_MAKER_WALLETS adds wallets to follow.`;

export class DatasetUsageError extends Error {}

export function datasetArgs(argv: readonly string[]): { out: string; pools?: string } {
  let out: string | undefined;
  let pools: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const given = argv[++i];
      if (!given || given.startsWith("--")) throw new DatasetUsageError(`${arg} needs a folder.`);
      return given;
    };
    if (arg === "--out") out = value();
    else if (arg === "--pools") pools = value();
    else throw new DatasetUsageError(`Unknown argument ${arg}.`);
  }
  if (!out) throw new DatasetUsageError("--out is required.");
  return { out, ...(pools ? { pools } : {}) };
}

const size = (bytes: number) => (bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`);

export async function runDataset(argv: readonly string[], env: Record<string, string | undefined>): Promise<void> {
  const args = datasetArgs(argv);
  const out = expandHome(args.out);
  const watcher = watchUrl(env.BRAINCHAIN_WATCH_URL);
  const rpc = rpcSetting(env[RPC_SETTING]);
  const redact = redactor(rpc);
  const say = (line: string) => console.error(`${new Date().toISOString()} ${redact(line)}`);
  const { token, note } = githubToken(env);
  if (note) say(note);
  const wallets = [...MARKET_MAKERS, ...configuredMakers(env.BRAINCHAIN_MAKER_WALLETS)];
  const requests = new Requests({
    allowances: [{ hosts: [new URL(ROBINHOOD_RPC).host], perHour: 4_000 }, ...(rpc ? [{ hosts: [rpc.host], perHour: 60_000 }] : [])],
  });
  const release = lockStateDir(join(out, STATE_DIR), process.pid, undefined, { file: "build.lock", busy: (owner, dir) => `Another build (process ${owner}) is using ${dir}. Wait for it to finish.` });
  try {
    const report = await buildDataset({
      out,
      watcher,
      pools: args.pools ? poolDir(expandHome(args.pools)) : poolWatcher(watcher),
      reader: chainReader(requests, rpc),
      ...(rpc ? { scan: privateReader(requests.fetchFor("scan"), rpc), batch: batchedReader(rpc, requests.fetchFor("batch")) } : {}),
      wallets,
      say,
      ...(token ? {} : { listReads: 40 }),
    });
    const bytes = Object.values(report.files).reduce((sum, { bytes }) => sum + bytes, 0);
    const shown = Object.entries(report.files).filter(([path]) => !/^(pools|symbols)\//.test(path));
    const group = (folder: string) => {
      const parts = Object.entries(report.files).filter(([path]) => path.startsWith(`${folder}/`));
      return `${folder}/: ${parts.length} files, ${parts.reduce((sum, [, { rows }]) => sum + rows, 0).toLocaleString("en-US")} rows, ${size(parts.reduce((sum, [, { bytes }]) => sum + bytes, 0))}`;
    };
    console.log(`dataset ${report.date}: head block ${report.headBlock} (chain ${report.through.head}, pools ${report.through.pools}, approvals ${report.through.approvals}), ${size(bytes)} in ${Math.round(report.ms / 1000)} s`);
    for (const [path, { rows, bytes: fileBytes }] of shown) console.log(`  ${path}: ${rows.toLocaleString("en-US")} rows, ${size(fileBytes)}`);
    console.log(`  ${group("pools")}`);
    console.log(`  ${group("symbols")}`);
    console.log(`  added: ${Object.entries(report.added).map(([name, n]) => `${name} ${n.toLocaleString("en-US")}`).join(", ") || "nothing"}`);
    for (const line of report.notes) console.log(`  note: ${line}`);
    console.log(`  manifest: ${join(out, "manifests", `${report.date}.json`)}`);
    if (!report.complete) {
      console.log("The build is not complete yet: run it again and it goes on from where it stopped. Publish only a complete build.");
      process.exitCode = 2;
    }
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : String(error)));
  } finally {
    release();
  }
}
