import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expandHome } from "../config.js";
import { hasGitHubToken, useGitHubToken } from "../github.js";
import { ChainError } from "../history.js";
import { configuredMakers, firstApprovals, MARKET_MAKERS } from "../makers.js";
import { marketCap, type CapKept } from "../marketcap.js";
import { ROBINHOOD_RPC } from "../premiums.js";
import { readinessIn } from "../readiness.js";
import { sightingsReader, tokenSightings } from "../sightings.js";
import { bitGoLists, bitGoMerges, bitGoPullRequests, bitGoReleases } from "./bitgo.js";
import { chainFirsts, chainKept, chainPoller } from "./chain.js";
import { chainTurn, createdIn, eventContext, loadWorth, saveWorth, worthOf } from "./context.js";
import { Deliveries } from "./deliver.js";
import { EventLog, type WatchEvent } from "./events.js";
import { Requests } from "./http.js";
import { listMerges, listPullRequests, METAMASK, TRUST_WALLET } from "./lists.js";
import { pinnedPost, publicTarget } from "./net.js";
import { PoolIndex } from "./pools.js";
import { chainReader, privateReader, redactor, RPC_SETTING, rpcSetting } from "./rpc.js";
import { serveEvents } from "./serve.js";
import { lockStateDir, StateFile } from "./state.js";
import { coingecko, gate, kucoin, lifi, robinhoodPages, robinhoodPairs } from "./venues.js";
import { Watcher, type Poller } from "./watcher.js";
import { indexedWorth, type EthKept } from "./worth.js";

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
  --trust-proxy          Behind Cloudflare and a proxy such as Render's, take a client's address from CF-Connecting-IP, or
                         else from the X-Forwarded-For entry before the proxy's own.

Environment: GITHUB_TOKEN, or GITHUB_TOKEN_FILE naming a file that holds it, lets the watcher read GitHub about once a
minute; without one each GitHub source is read every ten minutes, inside the 60 requests an hour GitHub allows one IP
address. BRAINCHAIN_WATCH_RPC reads Robinhood Chain from another RPC, with the public endpoint as the fallback.
BRAINCHAIN_MAKER_WALLETS adds wallets to follow. GET /health shows anyone whether each source is reading, and its full
detail to a request with BRAINCHAIN_WATCH_ADMIN_TOKEN as a Bearer token.`;

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
/** How often each GitHub source is read: about once a minute with a token, every ten minutes without one. */
export const githubEvery = (token: boolean) => (token ? GITHUB_EVERY.withToken : GITHUB_EVERY.withoutToken);
/** How many requests an hour the watcher allows itself: GitHub's API with and without a key, and each Robinhood Chain endpoint. */
export const ALLOWANCES = { githubWithToken: 4_000, githubWithoutToken: 50, publicChain: 4_000, privateChain: 20_000, poolFill: 20_000 };

/**
 * Reads GitHub with the token in GITHUB_TOKEN_FILE's file or in GITHUB_TOKEN, checked as the MCP server checks it, and says
 * what is wrong with one it cannot use. Neither value is ever part of a message.
 */
export function githubToken(env: Record<string, string | undefined>): { token: boolean; note?: string } {
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
  const github = githubEvery(token);
  const reader = chainReader(requests, rpc);
  const kept = chainKept();
  // Every pool on the chain, so a token's pools are a lookup. It is filled from the private endpoint alone, on an allowance
  // of its own so the fill never holds back the polls, and then kept current by the chain poll.
  const poolIndex = new PoolIndex(dir, say);
  const fillRequests = new Requests({ allowances: rpc ? [{ hosts: [rpc.host], perHour: ALLOWANCES.poolFill }] : [] });
  const eth: EthKept = {};
  // Each token's pool index and creation block are kept on disk, so a restart does not search its history again.
  const worthFile = join(dir, "worth.json");
  const worthKept = loadWorth(worthFile);
  // The hosted watcher's address is shared, and the public endpoint often turns it away: a long search it refuses is
  // answered from state instead, and tried again next time.
  const capKept: CapKept = { starts: new Map(), pools: new Map(), swaps: new Map(), changes: new Map(), supply: new Map(), times: new Map(), index: worthKept.index, byState: true };
  let saving: ReturnType<typeof setTimeout> | undefined;
  const keepWorth = () => {
    saving ??= setTimeout(() => {
      saving = undefined;
      try {
        saveWorth(worthFile, worthKept);
      } catch (error) {
        say(`the pool index could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 5_000);
  };
  const lists = bitGoLists(requests);
  // Where each token's contract was created, so the search for its pools starts there and not at the chain's first block.
  const created = new Map<string, Promise<bigint | undefined>>();
  const createdBlock = (address: `0x${string}`) => {
    const key = address.toLowerCase();
    const known = worthKept.created.get(key);
    if (known !== undefined) return Promise.resolve(known);
    if (!created.has(key)) {
      const found = reader.getBlockNumber().then((newest) => createdIn(reader, address, newest));
      created.set(key, found);
      // A failed search is tried again next time; a found block never changes.
      void found.then((block) => (block === undefined ? created.delete(key) : worthKept.created.set(key, block)));
    }
    return created.get(key)!;
  };

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
    // With a private endpoint the chain is read every 10 s, so an event is out within about 20 s of its block.
    chainPoller({ reader, wallets, watched: tracked, firsts: chainFirsts(reader, kept), ...(rpc ? { interval: 10_000 } : {}), onPools: (from, to, pools) => poolIndex.addLive(from, to, pools) }),
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
  // The timeline takes only Trust Wallet's and MetaMask's dates from the sightings, so the context reads their files and no
  // other list: Bitstamp's robots.txt closes its API to a watcher, and the exchanges' lists are megabytes each.
  const allSightings = sightingsReader(requests.fetchFor("context"));
  const GITHUB_HOSTS = new Set(["raw.githubusercontent.com", "github.com", "api.github.com"]);
  const sightings: typeof allSightings = { get: (source) => (GITHUB_HOSTS.has(new URL(source.url).host) ? allSightings.get(source) : Promise.reject(new Error("Not read by the watcher."))) };
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
    // Off the delivery path, the slow parts get longer: what is not ready by the first deadline follows as an update.
    ms: 150_000,
    // The public endpoint turns the hosted address away for minutes at a time; an older token's worth waits that out.
    patience: 12 * 60_000,
    worth: async (address) => {
      if (poolIndex.ready) {
        try {
          return await indexedWorth(reader, address, poolIndex, eth);
        } catch (error) {
          // An answer about the token stands; a read that failed is tried the long way, which ends at the public endpoint.
          if (error instanceof ChainError) throw error;
        }
      }
      try {
        return worthOf(await marketCap(reader, address, capKept, new Date(), undefined, await createdBlock(address)));
      } finally {
        keepWorth();
      }
    },
    say: (line) => say(line),
  });

  const deliveries = new Deliveries({ dir, log, post: pinnedPost(), check: async (url) => void (await publicTarget(url.hostname)), say });
  const adminToken = env.BRAINCHAIN_WATCH_ADMIN_TOKEN?.trim() || undefined;
  if (adminToken && !/^[\w-]{32,100}$/.test(adminToken)) throw new Error("BRAINCHAIN_WATCH_ADMIN_TOKEN must be 32 to 100 letters, digits, - or _.");
  const served = args.serve ? serveEvents({ log, health: () => health(), adminToken, deliveries, trustProxy: args.trustProxy }) : undefined;
  let ticking = false;
  const deliver = () => {
    if (ticking) return;
    ticking = true;
    setImmediate(() => {
      ticking = false;
      void deliveries.tick();
    });
  };
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
      deliver();
    },
    onUpdate: (event: WatchEvent, first: Record<string, unknown>) => {
      if (args.print) process.stdout.write(`${JSON.stringify({ type: "update", id: event.id, context: event.context })}\n`);
      served?.update(event);
      deliveries.update(event, first);
      deliver();
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
  let stopping = false;
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
      pools: poolIndex.status(),
      memoryMb: Math.round(process.memoryUsage().rss / 2 ** 20),
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
  if (rpc) void poolIndex.fill(privateReader(fillRequests.fetchFor("pools"), rpc));
  else say("No private RPC is set, so the pool index is not filled and each token's pools are searched for as they are needed.");

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    say("Stopping: finishing the reads in progress and saving the state.");
    served?.close();
    deliveries.stop();
    await watcher.stop();
    clearTimeout(saving);
    poolIndex.close();
    try {
      saveWorth(worthFile, worthKept);
    } catch {
      // A pool index that could not be saved is searched again after the restart.
    }
    log.close();
    release();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
