import { join } from "node:path";

import { expandHome } from "../config.js";
import { chainHistory, paced } from "../history.js";
import { configuredMakers, firstApprovals, MARKET_MAKERS } from "../makers.js";
import { ROBINHOOD_RPC } from "../premiums.js";
import { readinessIn } from "../readiness.js";
import { sightingsReader, tokenSightings } from "../sightings.js";
import { bitGoLists, bitGoMerges, bitGoPullRequests, bitGoReleases } from "./bitgo.js";
import { chainFirsts, chainKept, chainPoller } from "./chain.js";
import { chainTurn, eventContext } from "./context.js";
import { EventLog, type WatchEvent } from "./events.js";
import { Requests } from "./http.js";
import { listMerges, listPullRequests, METAMASK, TRUST_WALLET } from "./lists.js";
import { serveEvents } from "./serve.js";
import { lockStateDir, StateFile } from "./state.js";
import { coingecko, gate, kucoin, lifi, robinhoodPages, robinhoodPairs } from "./venues.js";
import { Watcher, type Poller } from "./watcher.js";

export const WATCH_USAGE = `Usage: brainchain-mcp watch [--state <dir>] [--serve [host:]<port>] [--print]

Watches public sources for changes about Robinhood Chain tokens and keeps each one as an event in an append-only log:
new Uniswap pools for tokens with a public trace, a followed market maker wallet's first approval or first receipt of a
token, pull requests and merges that add a Robinhood Chain token in BitGo's, Trust Wallet's and MetaMask's public code,
releases of @bitgo/statics that include one, Robinhood's pair list and crypto pages, and KuCoin's, Gate's, LI.FI's and
CoinGecko's lists. The first run records what is already public as a baseline and reports none of it as new.

  --state <dir>          Where the log and the watcher's state are kept (default: BRAINCHAIN_STATE_DIR/watch, or
                         ~/.brainchain/watch). A restart resumes from there.
  --serve [host:]<port>  Serve GET /events?since=&kinds=&tokens=&limit= and GET /health, read only, on 127.0.0.1
                         unless a host is given. Point BRAINCHAIN_WATCH_URL at it for brainchain_changes.
  --print                Write each new event to stdout as one line of JSON.

Environment: GITHUB_TOKEN lets the watcher read GitHub about once a minute; without it each GitHub source is read every
ten minutes, inside the 60 requests an hour GitHub allows one IP address. BRAINCHAIN_MAKER_WALLETS adds wallets to follow.`;

/** An argument the command cannot take: the usage goes out with it. */
export class UsageError extends Error {}

export interface WatchArgs {
  state?: string;
  serve?: { host: string; port: number };
  print: boolean;
}

/** The command's arguments, checked; throws what is wrong. */
export function watchArgs(argv: readonly string[]): WatchArgs {
  const args: WatchArgs = { print: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--print") args.print = true;
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

/** GitHub's tokens, classic and fine-grained, are letters, digits and underscores. */
const GITHUB_TOKEN = /^[A-Za-z0-9_]{20,255}$/;
export const GITHUB_EVERY = { withToken: 60_000, withoutToken: 10 * 60_000 };
/** How many requests an hour the watcher allows itself: GitHub's API with and without a key, and Robinhood Chain's endpoint. */
export const ALLOWANCES = { githubWithToken: 4_000, githubWithoutToken: 50, chain: 4_000 };
export const CHAIN_GAP_MS = 300;

export async function runWatch(argv: readonly string[], env: Record<string, string | undefined>, version: string): Promise<void> {
  const args = watchArgs(argv);
  const dir = expandHome(args.state ?? join(env.BRAINCHAIN_STATE_DIR?.trim() || "~/.brainchain", "watch"));
  const wallets = [...MARKET_MAKERS, ...configuredMakers(env.BRAINCHAIN_MAKER_WALLETS)];
  const token = env.GITHUB_TOKEN?.trim() || undefined;
  if (token && !GITHUB_TOKEN.test(token)) throw new Error("GITHUB_TOKEN is not a GitHub token, which is letters, digits and underscores. Fix it or unset it.");

  const release = lockStateDir(dir);
  const log = new EventLog(dir);
  const state = new StateFile(dir);
  const requests = new Requests({
    githubToken: token,
    validators: state.state.validators,
    allowances: [
      { hosts: ["api.github.com"], perHour: token ? ALLOWANCES.githubWithToken : ALLOWANCES.githubWithoutToken },
      { hosts: [new URL(ROBINHOOD_RPC).host], perHour: ALLOWANCES.chain },
    ],
  });
  const github = token ? GITHUB_EVERY.withToken : GITHUB_EVERY.withoutToken;
  // Wider apart than the tools' requests: the watcher runs for days, and the endpoint turns away an address that reads in bursts.
  const reader = chainHistory(ROBINHOOD_RPC, paced(requests.fetchFor("chain"), CHAIN_GAP_MS));
  const kept = chainKept();
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
  });
  const say = (line: string) => console.error(`${new Date().toISOString()} ${line}`);
  const watcher = new Watcher({
    log,
    state,
    pollers,
    context,
    say,
    onEvent: args.print ? (event: WatchEvent) => process.stdout.write(`${JSON.stringify(event)}\n`) : undefined,
  });

  say(`brainchain-mcp ${version} watch: state in ${dir}, ${log.size} events in the log (${log.baselineSize} from the baseline).`);
  say(
    token
      ? "GitHub is read with GITHUB_TOKEN: each GitHub source about once a minute, with ETags, so an unchanged answer costs nothing."
      : "GITHUB_TOKEN is not set, so GitHub is read without a key: each GitHub source every 10 minutes, to stay inside the 60 requests an hour GitHub allows one IP address. Set GITHUB_TOKEN to read it about once a minute.",
  );
  const pending = pollers.filter(({ name }) => state.source(name).baselined !== true).map(({ name }) => name);
  if (pending.length) say(`Recording the baseline for ${pending.join(", ")}: what is public now is kept and none of it is reported as new.`);

  const startedAt = new Date().toISOString();
  const health = () => {
    const stats = requests.stats();
    const sources = Object.fromEntries([...watcher.status].map(([name, status]) => [name, { ...status, requests: stats[name] ?? { lastHour: 0, total: 0, notModified: 0 } }]));
    const chain = state.source("chain") as { block?: number; startBlock?: number };
    return {
      ok: [...watcher.status.values()].every(({ failures }) => failures < 3),
      version,
      startedAt,
      readAt: new Date().toISOString(),
      events: { total: log.size, baseline: log.baselineSize, lastId: log.lastId },
      chain: { block: chain.block ?? null, startBlock: chain.startBlock ?? null },
      github: { token: requests.hasGitHubToken, ...(requests.github ? { limit: requests.github.limit, remaining: requests.github.remaining, reset: new Date(requests.github.reset).toISOString() } : {}) },
      waiting: requests.waiting(),
      sources,
      requests: stats,
    };
  };
  const server = args.serve && serveEvents(log, health);
  if (server && args.serve) {
    const { host, port } = args.serve;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    say(`Serving GET /events and GET /health on http://${host.includes(":") ? `[${host}]` : host}:${port}.`);
  }
  watcher.start();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    say("Stopping: finishing the reads in progress and saving the state.");
    server?.close();
    await watcher.stop();
    log.close();
    release();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
