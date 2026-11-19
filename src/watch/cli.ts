import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expandHome } from "../config.js";
import { hasGitHubToken, useGitHubToken } from "../github.js";
import { configuredMakers, firstApprovals, MARKET_MAKERS } from "../makers.js";
import { marketCap, type CapKept } from "../marketcap.js";
import { ROBINHOOD_RPC } from "../premiums.js";
import { readinessIn } from "../readiness.js";
import { sightingsReader, tokenSightings } from "../sightings.js";
import { bitGoLists, bitGoMerges, bitGoPullRequests, bitGoReleases } from "./bitgo.js";
import { chainFirsts, chainKept, chainPoller } from "./chain.js";
import { chainTurn, eventContext } from "./context.js";
import { Deliveries } from "./deliver.js";
import { EventLog, type WatchEvent } from "./events.js";
import { Requests } from "./http.js";
import { listMerges, listPullRequests, METAMASK, TRUST_WALLET } from "./lists.js";
import { pinnedPost, publicTarget } from "./net.js";
import { chainReader, redactor, RPC_SETTING, rpcSetting } from "./rpc.js";
import { serveEvents } from "./serve.js";
import { lockStateDir, StateFile } from "./state.js";
import { coingecko, gate, kucoin, lifi, robinhoodPages, robinhoodPairs } from "./venues.js";
import { Watcher, type Poller } from "./watcher.js";

export const WATCH_USAGE = `Usage: brainchain-mcp watch [--state <dir>] [--serve [host:]<port>] [--print] [--trust-proxy]

Watches public sources for changes about Robinhood Chain tokens and keeps each one as an event in an append-only log:
new Uniswap pools for tokens with a public trace, a followed market maker wallet's first approval or first receipt of a
token, pull requests and merges that add a Robinhood Chain token in BitGo's, Trust Wallet's and MetaMask's public code,
releases of @bitgo/statics that include one, Robinhood's pair list and crypto pages, and KuCoin's, Gate's, LI.FI's and
CoinGecko's lists. Each event carries the token's earlier public steps and what it is worth now. The first run records
what is already public as a baseline and reports none of it as new.

  --state <dir>          Where the log and the watcher's state are kept (default: BRAINCHAIN_STATE_DIR/watch, or
                         ~/.brainchain/watch). A restart resumes from there.
  --serve [host:]<port>  Serve the events on 127.0.0.1 unless a host is given: GET /events?since=&kinds=&tokens=&limit=,
                         GET /events/stream (server-sent events), POST /watches to have them sent to a webhook, Discord,
                         Slack or Telegram, GET and DELETE /watches/:id, and GET /health. Point BRAINCHAIN_WATCH_URL at it.
  --print                Write each new event to stdout as one line of JSON.
  --trust-proxy          Take a client's address from the last X-Forwarded-For entry, behind a proxy that appends it.

Environment: GITHUB_TOKEN, or GITHUB_TOKEN_FILE naming a file that holds it, lets the watcher read GitHub about once a
minute; without one each GitHub source is read every ten minutes, inside the 60 requests an hour GitHub allows one IP
address. BRAINCHAIN_WATCH_RPC reads Robinhood Chain from another RPC, with the public endpoint as the fallback.
BRAINCHAIN_MAKER_WALLETS adds wallets to follow.`;

/** An argument the command cannot take: the usage goes out with it. */
export class UsageError extends Error {}

export interface WatchArgs {
  state?: string;
  serve?: { host: string; port: number };
  print: boolean;
  trustProxy: boolean;
}

/** The command's arguments, checked; throws what is wrong. */
export function watchArgs(argv: readonly string[]): WatchArgs {
  const args: WatchArgs = { print: false, trustProxy: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--print") args.print = true;
    else if (arg === "--trust-proxy") args.trustProxy = true;
    else if (arg === "--state") {
      const dir = argv[++i];
      if (!dir) throw new UsageError("--state needs a folder.");
      args.state = dir;
    } else if (arg === "--serve") {
      const given = argv[++i] ?? "";
      const [, host = "127.0.0.1", port] = /^(?:([\w.-]+|\[[0-9a-fA-F:]+\]):)?(\d{1,5})$/.exec(given) ?? [];
      if (!port || Number(port) < 1 || Number(port) > 65_535) throw new UsageError("--serve needs a port, such as 8787, or a host and a port, such as 0.0.0.0:8787.");
      args.serve = { host: host.replace(/^\[|\]$/g, ""), port: Number(port) };
    } else throw new UsageError(`Unknown argument ${arg}.`);
  }
  return args;
}

export const GITHUB_EVERY = { withToken: 60_000, withoutToken: 10 * 60_000 };
/** How many requests an hour the watcher allows itself: GitHub's API with and without a key, and each Robinhood Chain endpoint. */
export const ALLOWANCES = { githubWithToken: 4_000, githubWithoutToken: 50, publicChain: 4_000, privateChain: 20_000 };

/**
 * Reads GitHub with the token in GITHUB_TOKEN_FILE's file or in GITHUB_TOKEN, checked as the MCP server checks it, and says
 * what is wrong with one it cannot use. Neither value is ever part of a message.
 */
function githubToken(env: Record<string, string | undefined>): { token: boolean; note?: string } {
  const file = env.GITHUB_TOKEN_FILE?.trim();
  if (file && !existsSync(expandHome(file))) {
    useGitHubToken(undefined);
    return { token: false, note: "GITHUB_TOKEN_FILE names a file that is not there yet, so GitHub is read without a key until the watcher restarts with it." };
  }
  const problem = useGitHubToken(file ? readFileSync(expandHome(file), "utf8").trim() : env.GITHUB_TOKEN?.trim());
  return { token: hasGitHubToken(), ...(problem ? { note: problem.replace("Fix it in this server's environment and restart the server.", "Fix it and restart the watcher.") } : {}) };
}

export async function runWatch(argv: readonly string[], env: Record<string, string | undefined>, version: string): Promise<void> {
  const args = watchArgs(argv);
  const dir = expandHome(args.state ?? join(env.BRAINCHAIN_STATE_DIR?.trim() || "~/.brainchain", "watch"));
  const wallets = [...MARKET_MAKERS, ...configuredMakers(env.BRAINCHAIN_MAKER_WALLETS)];
  const { token, note } = githubToken(env);
  const rpc = rpcSetting(env[RPC_SETTING]);
  const redact = redactor(rpc);
  const say = (line: string) => console.error(`${new Date().toISOString()} ${redact(line)}`);

  const release = lockStateDir(dir);
  const log = new EventLog(dir);
  const state = new StateFile(dir);
  const requests = new Requests({
    validators: state.state.validators,
    allowances: [
      { hosts: ["api.github.com"], perHour: token ? ALLOWANCES.githubWithToken : ALLOWANCES.githubWithoutToken },
      { hosts: [new URL(ROBINHOOD_RPC).host], perHour: ALLOWANCES.publicChain },
      ...(rpc ? [{ hosts: [rpc.host], perHour: ALLOWANCES.privateChain }] : []),
    ],
  });
  const github = token ? GITHUB_EVERY.withToken : GITHUB_EVERY.withoutToken;
  const reader = chainReader(requests, rpc);
  const kept = chainKept();
  const capKept: CapKept = { starts: new Map(), pools: new Map(), swaps: new Map(), changes: new Map(), supply: new Map(), times: new Map() };
  const lists = bitGoLists(requests);

  let watchedAt = -1;
  let watched = new Set<string>();
  const tracked = () => {
    if (log.size !== watchedAt) {
      watched = new Set(log.all().flatMap((event) => (event.kind !== "pool.created" && event.token.address ? [event.token.address.toLowerCase()] : [])));
      watchedAt = log.size;
    }
    return watched;
  };

  const pollers: Poller[] = [
    chainPoller({ reader, wallets, watched: tracked, firsts: chainFirsts(reader, kept) }),
    bitGoPullRequests(requests, lists, github),
    bitGoMerges(requests, lists, github),
    bitGoReleases(requests, lists),
    listPullRequests(requests, TRUST_WALLET, github),
    listMerges(requests, TRUST_WALLET, github),
    listPullRequests(requests, METAMASK, github),
    listMerges(requests, METAMASK, github),
    robinhoodPairs(requests),
    robinhoodPages(requests),
    kucoin(requests),
    gate(requests),
    lifi(requests),
    coingecko(requests),
  ];
  const sightings = sightingsReader(requests.fetchFor("context"));
  const context = eventContext({
    log,
    wallets,
    times: new Map(),
    readers: {
      chain: chainTurn(reader),
      readiness: readinessIn,
      approvals: (chain, address, followed, newest) => firstApprovals(chain, address, followed, kept, newest),
      sightings: (address) => tokenSightings(sightings, address),
    },
    worth: (address) => marketCap(reader, address, capKept),
  });

  const deliveries = new Deliveries({ dir, log, post: pinnedPost(), check: async (url) => void (await publicTarget(url.hostname)), say });
  const served = args.serve ? serveEvents({ log, health: () => health(), deliveries, trustProxy: args.trustProxy }) : undefined;
  let ticking = false;
  const watcher = new Watcher({
    log,
    state,
    pollers,
    context,
    say,
    redact,
    onEvent: (event: WatchEvent) => {
      if (args.print) process.stdout.write(`${JSON.stringify(event)}\n`);
      served?.publish([event]);
      if (ticking) return;
      ticking = true;
      setImmediate(() => {
        ticking = false;
        void deliveries.tick();
      });
    },
  });

  say(`brainchain-mcp ${version} watch: state in ${dir}, ${log.size} events in the log (${log.baselineSize} from the baseline), ${deliveries.active} watches.`);
  if (note) say(note);
  say(
    token
      ? "GitHub is read with a token: each GitHub source about once a minute, with ETags, so an unchanged answer costs nothing."
      : "No GitHub token is set, so GitHub is read without a key: each GitHub source every 10 minutes, to stay inside the 60 requests an hour GitHub allows one IP address. Set GITHUB_TOKEN or GITHUB_TOKEN_FILE to read it about once a minute.",
  );
  say(rpc ? `Robinhood Chain is read through the RPC in ${RPC_SETTING}, with the public endpoint as the fallback.` : "Robinhood Chain is read through its public endpoint.");
  const pending = pollers.filter(({ name }) => state.source(name).baselined !== true).map(({ name }) => name);
  if (pending.length) say(`Recording the baseline for ${pending.join(", ")}: what is public now is kept and none of it is reported as new.`);

  const startedAt = new Date().toISOString();
  const health = () => {
    const stats = requests.stats();
    const sources = Object.fromEntries([...watcher.status].map(([name, status]) => [name, { ...status, requests: stats[name] ?? { lastHour: 0, total: 0, notModified: 0 } }]));
    const chain = state.source("chain") as { block?: number; startBlock?: number };
    const waiting = Object.fromEntries(Object.entries(requests.waiting()).map(([host, wait]) => [redact(host), { ...wait, message: redact(wait.message) }]));
    return {
      ok: [...watcher.status.values()].every(({ failures }) => failures < 3),
      version,
      startedAt,
      readAt: new Date().toISOString(),
      events: { total: log.size, baseline: log.baselineSize, lastId: log.lastId, published: log.publishedThrough },
      chain: { block: chain.block ?? null, startBlock: chain.startBlock ?? null, rpc: rpc ? "configured, public endpoint as fallback" : "public endpoint" },
      github: { token, ...(requests.github ? { limit: requests.github.limit, remaining: requests.github.remaining, reset: new Date(requests.github.reset).toISOString() } : {}) },
      watches: deliveries.active,
      waiting,
      sources,
      requests: stats,
    };
  };
  if (served && args.serve) {
    const { host, port } = args.serve;
    await new Promise<void>((resolve, reject) => {
      served.server.once("error", reject);
      served.server.listen(port, host, () => resolve());
    });
    say(`Serving the events on http://${host.includes(":") ? `[${host}]` : host}:${port}.`);
  }
  watcher.start();
  deliveries.start();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    say("Stopping: finishing the reads in progress and saving the state.");
    served?.close();
    deliveries.stop();
    await watcher.stop();
    log.close();
    release();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
