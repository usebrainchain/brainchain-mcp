import { createHash } from "node:crypto";
import { appendFileSync, closeSync, createReadStream, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { getAddress, zeroAddress, type Address, type Hash } from "viem";

import { blockTime, remember, STRETCH_BLOCKS, type ChainHistory } from "../history.js";
import type { MakerWallet } from "../makers.js";
import { dated, queuedKept, queuedPools, registryLogs } from "../queued.js";
import { initializeEvent, poolCreatedEvent, UNISWAP_V3, UNISWAP_V4 } from "../readiness.js";
import { listedSince, sightingsReader } from "../sightings.js";
import { BASES } from "../watch/chain.js";
import type { WatchEvent } from "../watch/events.js";
import { INDEX_FROM, poolOf, poolsIn, type IndexedPool, type PoolLog } from "../watch/pools.js";
import { again, approvalsIn, blockTimes, confirmedBy, inOrder, namesOf, type FoundApproval } from "./chain.js";
import { confirmed, csv, EVENT_COLUMNS, FILES, jsonl, OUTCOME_COLUMNS, OUTCOME_WORDS, outcomeKey, parseJsonl, poolShard, sha256, STEP_WORDS, stepKey, symbolBucket, type FileEntry, type Manifest, type OutcomeRow, type PoolRow, type StepRow, type SymbolRow, type TokenRow } from "./format.js";
import { baseRates, type PoolPieces } from "./rates.js";
import { outcomesFromEvents, stepsFromEvents, tracedIn, type Traced } from "./rows.js";
import { gateStarts, kucoinStarts, robinhoodPageName, watcherEvents, type PoolSource } from "./sources.js";
import { TokenTable } from "./table.js";

/** `base-rates.json` counts pools by stretches of this many blocks, each with the time its last block was made. */
export const PIECE = 10_000;
/** The build keeps what it has read so far here, inside the output directory and outside what is published. */
export const STATE_DIR = ".build";
const FEED_ITEMS = 100;
export const DATA_REPO = "https://github.com/usebrainchain/brainchain-mcp-data";

interface State {
  firstRun?: { at: string; head: number };
  pools?: { source: string; offset: number; through: number };
  /** Pools read from the chain itself above the index. */
  chainPools?: number;
  approvals?: number;
  /** The time, in seconds, of the last block of each whole stretch of `PIECE` blocks. */
  pieces?: number[];
  /** When master took each Trust Wallet or MetaMask file, by "source|token"; empty when it cannot be shown. */
  lists?: Record<string, string>;
  /** The name on Robinhood's page for each symbol read, empty for a page without one, and when it was read. */
  pages?: Record<string, { name: string; at: string }>;
}

export interface BuildOptions {
  out: string;
  watcher: URL;
  pools: PoolSource;
  /** The chain, read as the tools read it: a private RPC first, the public endpoint when it fails. */
  reader: ChainHistory;
  /** A private RPC alone, for the long scans of ten thousand blocks a request; without one they go a piece at a time over `reader`. */
  scan?: ChainHistory;
  /** The private RPC in batches, for the times of many blocks and the names of many tokens. */
  batch?: ChainHistory;
  /** Blocks per request of a scan: 10,000 on Chainstack, 30,000 on the public endpoint. */
  span?: number;
  wallets: readonly MakerWallet[];
  fetch?: typeof fetch;
  say?: (line: string) => void;
  now?: () => Date;
  /** How long the slow backfills may run in one build; what is left goes on in the next. */
  budgetMs?: number;
  /** How many list files without a date may be read from GitHub in one build: one request each from the API. */
  listReads?: number;
}

export interface BuildReport {
  date: string;
  readAt: string;
  headBlock: number;
  through: { head: number; pools: number; approvals: number };
  files: Record<string, FileEntry & { bytes: number }>;
  added: Record<string, number>;
  ms: number;
  /** Whether every scan of the chain reached the head; a build that is not goes on from where it stopped. */
  complete: boolean;
  notes: string[];
}

const readJson = <T>(path: string, fallback: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback);
function writeWhole(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}
const rowsOf = <T>(path: string): T[] => (existsSync(path) ? parseJsonl<T>(readFileSync(path, "utf8")) : []);

/** Lines of a JSONL file as they stream, so a file of hundreds of megabytes is never held whole. */
async function* streamed<T>(path: string): AsyncGenerator<T> {
  if (!existsSync(path)) return;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) if (line.trim()) yield JSON.parse(line) as T;
}

/**
 * Cuts a last line a killed build left half written, which the next append would otherwise run into and break. Only the
 * file's end is read, so this costs the same for a file of any size.
 */
export function trimTail(path: string): void {
  const size = statSync(path).size;
  if (size === 0) return;
  const fd = openSync(path, "r+");
  try {
    const tail = Buffer.alloc(Math.min(size, 1 << 16));
    readSync(fd, tail, 0, tail.length, size - tail.length);
    if (tail[tail.length - 1] === 0x0a) return;
    const end = tail.lastIndexOf(0x0a);
    ftruncateSync(fd, end === -1 ? Math.max(0, size - tail.length) : size - tail.length + end + 1);
  } finally {
    closeSync(fd);
  }
}

/** A file's SHA-256 and its lines, read a chunk at a time into `chunk`, so a file of any size takes no more memory than it. */
function hashed(path: string, chunk: Buffer): { digest: string; lines: number; bytes: number } {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  let lines = 0;
  let bytes = 0;
  try {
    for (let read = readSync(fd, chunk, 0, chunk.length, null); read > 0; read = readSync(fd, chunk, 0, chunk.length, null)) {
      const part = chunk.subarray(0, read);
      hash.update(part);
      for (let at = part.indexOf(0x0a); at !== -1; at = part.indexOf(0x0a, at + 1)) lines++;
      bytes += read;
    }
  } finally {
    closeSync(fd);
  }
  return { digest: hash.digest("hex"), lines, bytes };
}

const shardFiles = (out: string, folder: string) => (existsSync(join(out, folder)) ? readdirSync(join(out, folder)).filter((name) => name.endsWith(".jsonl")).sort().map((name) => `${folder}/${name}`) : []);

/** Appends rows to files under `out`, grouped by file, each group in one write. */
function appendGrouped<T extends object>(out: string, rows: readonly T[], fileOf: (row: T) => string): void {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const file = fileOf(row);
    const group = groups.get(file);
    if (group) group.push(row);
    else groups.set(file, [row]);
  }
  for (const [file, group] of groups) {
    mkdirSync(dirname(join(out, file)), { recursive: true });
    appendFileSync(join(out, file), jsonl(group));
  }
}

/**
 * The pool's other side as the index writes it, already checksummed: hashing each of a million and a half pools' addresses
 * again would cost a build most of its memory and time for nothing.
 */
const otherSide = (pool: IndexedPool, token: string) => {
  const other = pool.currency0.toLowerCase() === token ? pool.currency1 : pool.currency0;
  return other.toLowerCase() === zeroAddress ? "ETH" : other;
};
const venueBit = (pool: { version: 3 | 4 }) => (pool.version === 3 ? 1 : 2);
const venueName = (version: 3 | 4) => (version === 3 ? "Uniswap v3" : "Uniswap v4");
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/**
 * Builds the BrainChain MCP dataset in `out`, adding to what an earlier build left there: the files publish.mjs takes,
 * and today's manifest. Everything that is a row is appended, never rewritten; the CSV files, the base rates and the
 * feeds are worked out again from the rows. The watcher's log gives the steps public sources record and the venues' own
 * listings, its pool index every token with a pool, and the job's own scans of the chain the market makers' approvals
 * and queued pools of every token.
 */
export async function buildDataset(options: BuildOptions): Promise<BuildReport> {
  const { out, watcher, reader, wallets, fetch: fetchImpl = fetch, say = () => {}, now = () => new Date() } = options;
  const started = Date.now();
  const deadline = started + (options.budgetMs ?? 50 * 60_000);
  const late = () => Date.now() > deadline;
  const scan = options.scan ?? reader;
  const batch = options.batch ?? reader;
  const span = options.span ?? (options.scan ? 10_000 : 30_000);
  const notes: string[] = [];
  const added: Record<string, number> = {};
  const count = (name: string, n: number) => {
    if (n > 0) added[name] = (added[name] ?? 0) + n;
  };

  mkdirSync(join(out, STATE_DIR), { recursive: true });
  const statePath = join(out, STATE_DIR, "state.json");
  const state = readJson<State>(statePath, {});
  const save = () => writeWhole(statePath, `${JSON.stringify(state)}\n`);
  const readAt = now().toISOString();
  const head = Number(await reader.getBlockNumber());
  state.firstRun ??= { at: readAt, head };
  const backfill = (block?: number) => (block === undefined || block <= state.firstRun!.head ? { backfill: true as const } : {});
  save();

  const eventsPath = join(out, "events.jsonl");
  const outcomesPath = join(out, "outcomes.jsonl");
  const tokensPath = join(out, "tokens.jsonl");
  // publish.mjs takes every file in every manifest, so a file with no rows yet is there, empty.
  for (const path of [eventsPath, outcomesPath, tokensPath]) if (!existsSync(path)) writeFileSync(path, "");
  for (const path of [eventsPath, outcomesPath, tokensPath, ...[...shardFiles(out, "pools"), ...shardFiles(out, "symbols")].map((file) => join(out, file))]) trimTail(path);
  const steps = rowsOf<StepRow>(eventsPath);
  const stepKeys = new Set(steps.map(stepKey));
  /** Appends the steps not written before, oldest first. */
  const addSteps = (rows: readonly StepRow[]) => {
    const fresh = rows.filter((row) => !stepKeys.has(stepKey(row)));
    const unique = [...new Map(fresh.map((row) => [stepKey(row), row])).values()].sort((a, b) => (a.at ?? a.by ?? "").localeCompare(b.at ?? b.by ?? "") || a.token.localeCompare(b.token));
    if (unique.length === 0) return;
    appendFileSync(eventsPath, jsonl(unique));
    for (const row of unique) stepKeys.add(stepKey(row));
    steps.push(...unique);
    count("events.jsonl", unique.length);
  };

  say(`reading the watcher's log at ${watcher.origin}`);
  // The context each event carries is the watcher's own reading and is never a row, so it is not kept.
  const events: WatchEvent[] = (await watcherEvents(watcher, fetchImpl)).map((event) => ({ ...event, context: {} }));
  const traced = tracedIn(events);

  // Trust Wallet's and MetaMask's files that were there when the watcher started have no date in its log.
  state.lists ??= {};
  const undatedLists = events.filter((event) => (event.kind === "trustwallet.merged" || event.kind === "metamask.merged") && !event.at && event.token.address);
  const lists = sightingsReader(fetchImpl);
  const toDate = undatedLists.filter((event) => !(`${event.kind === "trustwallet.merged" ? "Trust Wallet" : "MetaMask"}|${event.token.address!.toLowerCase()}` in state.lists!)).length;
  if (toDate) say(`dating ${toDate} Trust Wallet and MetaMask files from GitHub`);
  let listReads = 0;
  for (const event of undatedLists) {
    const source = event.kind === "trustwallet.merged" ? "Trust Wallet" : "MetaMask";
    const key = `${source}|${event.token.address!.toLowerCase()}`;
    if (key in state.lists) continue;
    if (listReads >= (options.listReads ?? Infinity) || late()) break;
    listReads++;
    try {
      state.lists[key] = (await listedSince(lists, source, getAddress(event.token.address!))) ?? "";
    } catch {
      // GitHub refused or failed: asked again in the next build.
    }
  }
  save();
  const listDates = new Map(Object.entries(state.lists).filter(([, since]) => since !== ""));
  const leftLists = undatedLists.filter((event) => !(`${event.kind === "trustwallet.merged" ? "Trust Wallet" : "MetaMask"}|${event.token.address!.toLowerCase()}` in state.lists!)).length;
  if (leftLists) notes.push(`${leftLists} Trust Wallet and MetaMask files are not dated yet; later builds read them from GitHub.`);
  addSteps(stepsFromEvents(events, listDates));

  // The followed wallets' approvals of every token, read once from the first block and then only the new blocks.
  const times = new Map<string, Promise<bigint>>();
  const timeOf = (block: number) => remember(times, String(block), async () => BigInt(Date.parse(await blockTime(reader, BigInt(block))) / 1000));
  const firstSeen = new Set(steps.filter((row) => row.step === "approval").map((row) => `${row.maker!.wallet.toLowerCase()}|${row.token.toLowerCase()}`));
  const scanFrom = (state.approvals ?? INDEX_FROM - 1) + 1;
  if (scanFrom <= head) {
    say(`scanning blocks ${scanFrom} to ${head} for the followed wallets' approvals, ${span} blocks a request`);
    state.approvals = await inOrder(scanFrom, head, { span, atOnce: 4, gap: 100, stop: late }, (from, to) => approvalsIn(scan, wallets, from, to), async (from, to, found: FoundApproval[]) => {
      const firsts = new Map<string, FoundApproval>();
      for (const approval of found.sort((a, b) => a.block - b.block || a.index - b.index)) {
        const key = `${approval.wallet.toLowerCase()}|${approval.token.toLowerCase()}`;
        if (!firstSeen.has(key) && !firsts.has(key)) firsts.set(key, approval);
      }
      const rows: StepRow[] = [];
      for (const [key, { token, wallet, spender, block, transaction }] of firsts) {
        const maker = wallets.find((candidate) => candidate.wallet.toLowerCase() === wallet.toLowerCase())!;
        const at = iso(Number(await timeOf(block)));
        const confirmed = await confirmedBy(reader, maker, transaction);
        firstSeen.add(key);
        rows.push({ token: getAddress(token), step: "approval", source: "Robinhood Chain", at, atFrom: "block", block, transaction, maker: { ...(maker.name ? { name: maker.name } : {}), ...(maker.tag ? { tag: maker.tag } : {}), wallet: maker.wallet }, spender, confirmed, observedAt: readAt, ...backfill(block) });
      }
      addSteps(rows);
      state.approvals = to;
      save();
    });
    save();
  }
  if ((state.approvals ?? 0) < head) notes.push(`The approvals are read through block ${state.approvals ?? INDEX_FROM - 1} of ${head}; the next build goes on from there.`);

  // Each market maker's registry of queued pools, read whole: a few requests of ten million blocks.
  const kept = queuedKept();
  for (const maker of wallets) {
    if (!maker.registry) continue;
    const logs = [];
    for (let from = 0n; from <= BigInt(head); from += STRETCH_BLOCKS) {
      const to = from + STRETCH_BLOCKS - 1n < BigInt(head) ? from + STRETCH_BLOCKS - 1n : BigInt(head);
      // Only the public endpoint searches ten million blocks a request, and it turns a shared address away at times: a
      // stretch it keeps refusing is read from the private RPC instead, ten thousand blocks a request.
      const stretch = await again(() => registryLogs(reader, maker.registry!, from, to), 4).catch(async () => {
        const found: Awaited<ReturnType<typeof registryLogs>> = [];
        await inOrder(Number(from), Number(to), { span: 10_000, atOnce: 4, gap: 100 }, (low, high) => registryLogs(scan, maker.registry!, BigInt(low), BigInt(high)), (_, __, part) => void found.push(...part));
        return found;
      });
      logs.push(...stretch);
    }
    const ops = await queuedPools(reader, logs, kept);
    const first = new Map<string, (typeof ops)[number]>();
    for (const op of ops) for (const side of [op.currency0, op.currency1]) if (!BASES.has(side.toLowerCase()) && !first.has(side.toLowerCase())) first.set(side.toLowerCase(), op);
    const rows: StepRow[] = [];
    for (const [token, op] of first) {
      const queued = await dated(reader, maker, op, logs);
      const other = op.currency0.toLowerCase() === token ? op.currency1 : op.currency0;
      rows.push({
        token: getAddress(token),
        step: "pool_queued",
        source: "Robinhood Chain",
        at: queued.at,
        atFrom: "block",
        block: queued.block,
        transaction: queued.transaction,
        maker: { ...(maker.name ? { name: maker.name } : {}), ...(maker.tag ? { tag: maker.tag } : {}), wallet: maker.wallet },
        pool: queued.pool,
        pairedWith: other.toLowerCase() === zeroAddress ? "ETH" : getAddress(other),
        ...(queued.granted ? { granted: queued.granted } : {}),
        confirmed: queued.confirmed,
        observedAt: readAt,
        ...backfill(queued.block),
      });
    }
    addSteps(rows);
  }

  // Tokens the scans found join the traced ones.
  for (const row of steps) {
    const key = row.token.toLowerCase();
    if (!traced.has(key)) traced.set(key, { token: row.token, symbols: new Set(), names: new Set(), sources: new Set([row.source]), observedAt: row.observedAt, baseline: row.backfill === true });
  }

  // Every token's first pool on each venue: the pool files already written, then the index's new lines, then the chain
  // itself for any blocks the index has not reached.
  const table = new TokenTable(1 << 21);
  const tracedPools = new Map<string, Map<3 | 4, { block: number; pairedWith: string }>>();
  const noteTraced = (token: string, version: 3 | 4, block: number, pairedWith: string) => {
    if (!traced.has(token)) return;
    const venues = tracedPools.get(token) ?? new Map();
    if (!venues.has(version) || block < venues.get(version)!.block) venues.set(version, { block, pairedWith });
    tracedPools.set(token, venues);
  };
  for (const file of shardFiles(out, "pools")) {
    for await (const row of streamed<PoolRow>(join(out, file))) {
      const version = row.source === "Uniswap v3" ? 3 : 4;
      table.addPool(row.token, version === 3 ? 1 : 2, row.block);
      noteTraced(row.token.toLowerCase(), version, row.block, row.pairedWith);
    }
  }
  const addPools = (pools: readonly IndexedPool[]) => {
    const rows: PoolRow[] = [];
    for (const pool of pools) {
      for (const token of pool.currency0 === pool.currency1 ? [pool.currency0] : [pool.currency0, pool.currency1]) {
        const side = token.toLowerCase();
        if (BASES.has(side)) continue;
        noteTraced(side, pool.version, pool.block, otherSide(pool, side));
        if (!table.addPool(side, venueBit(pool), pool.block)) continue;
        rows.push({ token, source: venueName(pool.version), block: pool.block, pairedWith: otherSide(pool, side), observedAt: readAt, ...backfill(pool.block) });
      }
    }
    appendGrouped(out, rows, (row) => poolShard(row.block));
    count("pools", rows.length);
  };
  const source = options.pools;
  if (state.pools?.source !== source.name) state.pools = { source: source.name, offset: 0, through: 0 };
  say(`reading the pool index from ${source.name.replace(/^dir:.*/, "a local directory")}, from byte ${state.pools.offset}`);
  for (let pages = 0; ; pages++) {
    const page = await source.page(state.pools.offset);
    if (state.pools.offset > page.bytes) {
      // The index was filled again from the start; what was written stands, and its lines are read again.
      state.pools.offset = 0;
      continue;
    }
    addPools(page.pools);
    state.pools = { source: source.name, offset: page.next, through: page.through };
    if (pages % 20 === 0) save();
    if (page.next >= page.bytes || page.pools.length === 0) break;
  }
  save();
  const poolsFrom = Math.max(state.pools.through, state.chainPools ?? 0) + 1;
  if (poolsFrom <= head) {
    say(`reading pools from the chain for blocks ${poolsFrom} to ${head}, above the index`);
    state.chainPools = await inOrder(poolsFrom, head, { span: Math.min(span, 10_000), atOnce: 4, gap: 100, stop: late }, (from, to) => poolsIn(scan, BigInt(from), BigInt(to)), (_, to, pools) => {
      addPools(pools);
      state.chainPools = to;
      save();
    });
    save();
  }
  const poolsThrough = Math.max(state.pools.through, state.chainPools ?? 0);

  // The traced tokens' first pools as steps, with the transaction and the time of each.
  const poolRows: StepRow[] = [];
  const havePool = new Set(steps.filter((row) => row.step === "pool").map((row) => `${row.token.toLowerCase()}|${row.source}`));
  const wantedPools = [...tracedPools].flatMap(([token, venues]) => [...venues].filter(([version]) => !havePool.has(`${token}|${venueName(version)}`)).map(([version, first]) => ({ token, version, ...first })));
  const blockPools = new Map<number, Promise<(IndexedPool & { transaction: Hash })[]>>();
  const poolLogs = (block: number) => {
    if (!blockPools.has(block)) {
      const reading = reader
        .getLogs({ address: [UNISWAP_V3, UNISWAP_V4], events: [poolCreatedEvent, initializeEvent], fromBlock: BigInt(block), toBlock: BigInt(block), strict: true })
        .then((logs) => (logs as unknown as (PoolLog & { transactionHash: Hash })[]).map((log) => ({ ...poolOf(log), transaction: log.transactionHash })));
      blockPools.set(block, reading);
      reading.catch(() => blockPools.delete(block));
    }
    return blockPools.get(block)!;
  };
  const poolTimes = await blockTimes(batch, wantedPools.map(({ block }) => block));
  const byTransaction = new Map(events.filter((event) => event.kind === "pool.created").map((event) => [event.ref, event]));
  let poolsLeft = false;
  let nextPool = 0;
  const poolWorker = async () => {
    while (nextPool < wantedPools.length) {
      if (late()) {
        poolsLeft = true;
        return;
      }
      const { token, version, block, pairedWith } = wantedPools[nextPool++]!;
      const found = (await again(() => poolLogs(block))).find((pool) => pool.version === version && [pool.currency0, pool.currency1].some((currency) => currency.toLowerCase() === token));
      const watched = found && byTransaction.get(found.transaction);
      poolRows.push({
        token: getAddress(token),
        step: "pool",
        source: venueName(version),
        at: iso(poolTimes.get(block)!),
        atFrom: "block",
        block,
        ...(found ? { transaction: found.transaction, pool: found.pool } : {}),
        pairedWith,
        observedAt: watched?.observedAt ?? readAt,
        ...(watched ? (watched.baseline ? { backfill: true as const } : {}) : backfill(block)),
      });
    }
  };
  await Promise.all(Array.from({ length: 8 }, poolWorker));
  if (poolsLeft) notes.push("Some traced tokens' first pools are left for the next build.");
  addSteps(poolRows);

  // The venues: KuCoin's and Gate's own trading starts date their listings.
  const [kucoin, gate] = await Promise.allSettled([kucoinStarts(fetchImpl), gateStarts(fetchImpl)]);
  if (kucoin.status === "rejected") notes.push("KuCoin's pairs could not be read, so its listings are dated by when the watcher saw them.");
  if (gate.status === "rejected") notes.push("Gate's pairs could not be read, so its listings are dated by when the watcher saw them.");
  // A Robinhood page whose symbol a traced token goes by, with no name in the pair list to compare, is confirmed by the
  // name on the page itself. A page with none is read again after a week.
  state.pages ??= {};
  const pairNamed = new Set(events.filter((event) => event.kind === "robinhood.pair_added" && event.token.name).map((event) => event.token.symbol!.toUpperCase()));
  const symbols = new Set([...traced.values()].flatMap(({ symbols: named }) => [...named]));
  const pageSymbols = [...new Set(events.filter((event) => event.kind === "robinhood.page_added" && event.token.symbol).map((event) => event.token.symbol!.toUpperCase()))].filter((symbol) => symbols.has(symbol) && !pairNamed.has(symbol));
  const stale = (symbol: string) => {
    const read = state.pages![symbol];
    return !read || (read.name === "" && Date.parse(readAt) - Date.parse(read.at) > 7 * 86_400_000);
  };
  for (const symbol of pageSymbols.filter(stale)) {
    try {
      state.pages[symbol] = { name: await robinhoodPageName(symbol, fetchImpl), at: readAt };
    } catch {
      // Not read this time: the row is written unconfirmed, and the page is read again in the next build.
    }
  }
  save();
  const pageNames = new Map(Object.entries(state.pages).filter(([, { name }]) => name !== "").map(([symbol, { name }]) => [symbol, name]));
  const outcomes = rowsOf<OutcomeRow>(outcomesPath);
  const outcomeKeys = new Set(outcomes.map(outcomeKey));
  const fresh = outcomesFromEvents(events, traced, { kucoin: kucoin.status === "fulfilled" ? kucoin.value : new Map(), gate: gate.status === "fulfilled" ? gate.value : new Map() }, pageNames).filter((row) => {
    if (outcomeKeys.has(outcomeKey(row))) return false;
    outcomeKeys.add(outcomeKey(row));
    return true;
  });
  fresh.sort((a, b) => (a.at ?? a.by ?? "").localeCompare(b.at ?? b.by ?? "") || a.token.localeCompare(b.token));
  if (fresh.length) appendFileSync(outcomesPath, jsonl(fresh));
  outcomes.push(...fresh);
  count("outcomes.jsonl", fresh.length);

  // The traced tokens not written before; one the sources give no symbol is named by its contract.
  const tokens = rowsOf<TokenRow>(tokensPath);
  const known = new Set(tokens.map(({ token }) => token.toLowerCase()));
  const nameless = [...traced.values()].filter(({ token, symbols }) => !known.has(token.toLowerCase()) && symbols.size === 0);
  for (let i = 0; i < nameless.length; i += 200) {
    const chunk = nameless.slice(i, i + 200);
    const names = await again(() => namesOf(batch, chunk.map(({ token }) => token as Address)));
    chunk.forEach((entry, j) => {
      if (names[j]!.symbol) entry.symbols.add(names[j]!.symbol.toUpperCase());
      if (names[j]!.name) entry.names.add(names[j]!.name);
    });
  }
  const newTokens = [...traced.values()]
    .filter(({ token }) => !known.has(token.toLowerCase()))
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.token.localeCompare(b.token))
    .map(({ token, symbols, names, sources, observedAt, baseline }: Traced): TokenRow => ({
      token,
      ...(symbols.size ? { symbol: [...symbols][0]! } : {}),
      ...(names.size ? { name: [...names][0]! } : {}),
      sources: [...sources].sort(),
      observedAt,
      ...(baseline || state.firstRun!.at === readAt ? { backfill: true as const } : {}),
    }));
  if (newTokens.length) appendFileSync(tokensPath, jsonl(newTokens));
  count("tokens.jsonl", newTokens.length);

  // What every token with a pool calls itself, for looking a symbol up: read once a token.
  for (const file of shardFiles(out, "symbols")) for await (const row of streamed<SymbolRow>(join(out, file))) table.markNamed(row.token);
  let unnamed: Address[] = [];
  const nameThem = async () => {
    const chunks: Address[][] = [];
    for (let i = 0; i < unnamed.length; i += 200) chunks.push(unnamed.slice(i, i + 200));
    unnamed = [];
    let next = 0;
    const rows: SymbolRow[] = [];
    const worker = async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++]!;
        const names = await again(() => namesOf(batch, chunk));
        chunk.forEach((token, i) => rows.push({ symbol: names[i]!.symbol, token }));
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    appendGrouped(out, rows, (row) => symbolBucket(row.symbol));
    count("symbols", rows.length);
  };
  let symbolsLeft = false;
  for (const file of shardFiles(out, "pools")) {
    for await (const row of streamed<PoolRow>(join(out, file))) {
      if (!table.markNamed(row.token)) continue;
      unnamed.push(row.token as Address);
      if (unnamed.length >= 4_000) await nameThem();
      if (late()) {
        symbolsLeft = true;
        break;
      }
    }
    if (symbolsLeft) break;
  }
  await nameThem();
  if (symbolsLeft) notes.push("Some tokens' symbols are left for the next build.");

  // Every stretch of blocks with the time it ended, so a cut-off counts each pool only once its block was made.
  state.pieces ??= [];
  const whole = Math.floor((poolsThrough + 1) / PIECE);
  const missing = Array.from({ length: Math.max(0, whole - state.pieces.length) }, (_, i) => (state.pieces!.length + i + 1) * PIECE - 1);
  if (missing.length) say(`reading the times of ${missing.length} stretches of ${PIECE} blocks`);
  for (let i = 0; i < missing.length && !late(); i += 2_000) {
    const part = missing.slice(i, i + 2_000);
    const ends = await blockTimes(batch, part);
    state.pieces.push(...part.map((block) => ends.get(block)!));
    save();
  }
  if (state.pieces.length < whole) notes.push(`The times of ${whole - state.pieces.length} stretches of blocks are left for the next build; their pools are not counted until then.`);
  const partial = state.pieces.length >= whole && poolsThrough + 1 > whole * PIECE ? [Number(await timeOf(poolsThrough))] : [];
  const pieces: PoolPieces = { piece: PIECE, counts: table.firstPools(PIECE, poolsThrough), ends: [...state.pieces.slice(0, whole), ...partial] };

  const headBlock = Math.min(head, poolsThrough, state.approvals ?? 0);
  const headAt = Number(await timeOf(headBlock)) * 1000;
  const rates = baseRates({ steps, outcomes, pools: pieces, cut: Math.min(Date.parse(readAt), headAt) });
  const date = readAt.slice(0, 10);
  writeWhole(join(out, "events.csv"), csv(EVENT_COLUMNS, steps));
  writeWhole(join(out, "outcomes.csv"), csv(OUTCOME_COLUMNS, outcomes));
  writeWhole(join(out, "base-rates.json"), `${JSON.stringify({ readAt, headBlock, cut: new Date(Math.min(Date.parse(readAt), headAt)).toISOString(), through: { head, pools: poolsThrough, approvals: state.approvals ?? 0, wallets: wallets.map(({ wallet }) => wallet) }, unconfirmed: outcomes.filter((row) => !confirmed(row)).length, kinds: rates, pools: pieces }, null, 1)}\n`);
  const items = feedItems(steps, outcomes, traced);
  writeWhole(join(out, "feed.json"), `${JSON.stringify(jsonFeed(items), null, 1)}\n`);
  writeWhole(join(out, "feed.xml"), rss(items));

  const files: BuildReport["files"] = {};
  const listed = [...FILES, ...shardFiles(out, "pools"), ...shardFiles(out, "symbols")];
  const chunk = Buffer.alloc(1 << 20);
  for (const path of listed) {
    const { digest, lines, bytes } = hashed(join(out, path), chunk);
    // Every row ends in a newline, and a CSV file has a header line besides.
    const rows = path.endsWith(".jsonl") ? lines : path.endsWith(".csv") ? lines - 1 : path === "base-rates.json" ? rates.length : items.length;
    files[path] = { sha256: digest, rows, bytes };
  }
  const manifest: Manifest = { date, readAt, headBlock, files: Object.fromEntries(Object.entries(files).map(([path, { sha256: hash, rows }]) => [path, { sha256: hash, rows }])) };
  writeWhole(join(out, "manifests", `${date}.json`), `${JSON.stringify(manifest, null, 1)}\n`);
  const complete = (state.approvals ?? 0) >= head && poolsThrough >= head && state.pieces.length >= whole && !poolsLeft;
  return { date, readAt, headBlock, through: { head, pools: poolsThrough, approvals: state.approvals ?? 0 }, files, added, ms: Date.now() - started, complete, notes };
}

interface Item {
  id: string;
  title: string;
  text: string;
  url?: string;
  date: string;
}

/** The newest rows the job saw, newest first: what a reader of the feed has not seen before. */
function feedItems(steps: readonly StepRow[], outcomes: readonly OutcomeRow[], traced: ReadonlyMap<string, Traced>): Item[] {
  const name = (token: string) => {
    const known = traced.get(token.toLowerCase());
    const symbol = known && [...known.symbols][0];
    return symbol && /^[\w.$-]{1,20}$/.test(symbol) ? `${symbol} (${token})` : token;
  };
  const when = (row: { at?: string; by?: string }) => (row.at ? `Public from ${row.at}.` : `On record by ${row.by}; the source gives no date.`);
  const all = [
    ...steps.map((row) => ({ key: stepKey(row), title: `${name(row.token)}: ${STEP_WORDS[row.step]}`, text: `${row.source}. ${when(row)}`, url: row.ref ?? (row.transaction ? `https://robinhoodchain.blockscout.com/tx/${row.transaction}` : undefined), date: row.observedAt })),
    ...outcomes.map((row) => ({ key: outcomeKey(row), title: `${name(row.token)}: ${OUTCOME_WORDS[row.outcome]}`, text: `${row.venue}, matched by ${row.match}. ${when(row)}`, url: row.ref, date: row.observedAt })),
  ];
  return all
    .sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key))
    .slice(0, FEED_ITEMS)
    .map(({ key, title, text, url, date }) => ({ id: sha256(key).slice(0, 32), title, text, ...(url ? { url } : {}), date }));
}

function jsonFeed(items: readonly Item[]) {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: "BrainChain MCP dataset",
    home_page_url: DATA_REPO,
    feed_url: "https://raw.githubusercontent.com/usebrainchain/brainchain-mcp-data/main/feed.json",
    description: "Dated public steps of Robinhood Chain tokens, and the venues that listed them, as the BrainChain MCP records them.",
    items: items.map(({ id, title, text, url, date }) => ({ id, title, content_text: text, ...(url ? { url } : {}), date_published: date })),
  };
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function rss(items: readonly Item[]): string {
  const entries = items
    .map(({ id, title, text, url, date }) => `<item><guid isPermaLink="false">${id}</guid><title>${xml(title)}</title><description>${xml(text)}</description>${url ? `<link>${xml(url)}</link>` : ""}<pubDate>${new Date(date).toUTCString()}</pubDate></item>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>BrainChain MCP dataset</title><link>${DATA_REPO}</link><description>Dated public steps of Robinhood Chain tokens, and the venues that listed them, as the BrainChain MCP records them.</description>${entries}</channel></rss>\n`;
}
