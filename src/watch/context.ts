import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getAddress, type Address } from "viem";

import { BITGO_START, CustodyError, within, type CustodyAddition, type CustodyBoard } from "../custody.js";
import { ANSWER_MS, ChainError, type ChainHistory } from "../history.js";
import type { CapKept, MarketCapBoard, Pool } from "../marketcap.js";
import { SightingsError } from "../sightings.js";
import type { MakerWallet } from "../makers.js";
import { tokenTimeline, type TimelineReaders } from "../timeline.js";
import type { EventLog, WatchEvent } from "./events.js";
import { backoffIn, describe, type Reading } from "./watcher.js";

/** How long the context of one event may take before the event is written without its prior steps. */
export const CONTEXT_MS = ANSWER_MS;

/** BitGo's merges as the log holds them, in the form the timeline reads them, so the timeline never reads BitGo's history again. */
export function custodyFromLog(log: EventLog, now = new Date()): CustodyBoard {
  const byCommit = new Map<string, CustodyAddition>();
  for (const event of log.all()) {
    if (event.kind !== "bitgo.merged" || !event.at || typeof event.detail.id !== "string") continue;
    const addition = byCommit.get(event.ref) ?? { addedAt: event.at, commit: event.ref, tokens: [] };
    addition.tokens.push({ id: event.detail.id, ...(event.token.name ? { name: event.token.name } : {}), ...(event.token.address ? { contract: getAddress(event.token.address) } : {}) });
    byCommit.set(event.ref, addition);
  }
  return {
    chain: "Robinhood Chain",
    source: "https://github.com/BitGo/BitGoJS/tree/master/modules/statics/src/coins",
    readAt: now.toISOString(),
    since: new Date(BITGO_START).toISOString(),
    additions: [...byCommit.values()].sort((a, b) => b.addedAt.localeCompare(a.addedAt)),
  };
}

export interface ContextOptions {
  log: EventLog;
  /** The timeline's readers, wired to the watcher's own requests. */
  readers: Omit<TimelineReaders, "custody" | "listed">;
  wallets: readonly MakerWallet[];
  times: Map<string, Promise<bigint>>;
  /** The token's market cap now, read as brainchain_token_market_cap reads it. */
  worth?: (token: Address) => Promise<MarketCapBoard | Worth>;
  /** How long each read may take. */
  ms?: number;
  /**
   * How long the worth keeps trying when an endpoint asks the watcher to wait; each try goes on from the stretches the
   * last one read, and the worth follows as an update whenever it is read.
   */
  patience?: number;
  /** Told the cause of a read that failed for a reason the event does not show, for the operator's log, which redacts it. */
  say?: (line: string) => void;
}

/** What a token is worth when its event is published, and the pool that says so. */
export interface Worth {
  marketCapUsd?: string;
  priceUsd: string;
  supply?: string;
  liquidityUsd: string;
  thin: boolean;
  pool: { version: string; address?: string; id?: string; pairedWith: string };
  asOf: { block: number; at: string };
}

export const worthOf = (board: MarketCapBoard): Worth => ({
  ...(board.marketCapUsd ? { marketCapUsd: board.marketCapUsd } : {}),
  priceUsd: board.priceUsd,
  ...(board.supply ? { supply: board.supply } : {}),
  liquidityUsd: board.pool.liquidityUsd,
  thin: board.pool.thin,
  pool: { version: board.pool.version, ...(board.pool.address ? { address: board.pool.address } : {}), ...(board.pool.id ? { id: board.pool.id } : {}), pairedWith: board.pool.pairedWith },
  asOf: board.asOf,
});

/** Why a read failed, in words written for a reader: a source's own error can carry a node's address, so only ours pass. */
const UNREAD = "Robinhood Chain or a list could not be read just now.";
const ASKED_TO_WAIT = "Robinhood Chain's public endpoint asked the watcher to wait, so this was not read; the long searches it needs are served by that endpoint alone.";
export const why = (error: unknown) =>
  error instanceof ChainError || error instanceof CustodyError || error instanceof SightingsError || error instanceof LateError ? error.message : backoffIn(error) ? ASKED_TO_WAIT : UNREAD;

class LateError extends Error {}

/**
 * What goes with a new event: `priorTraces`, the token's dated public steps before the event, read by the token timeline;
 * `worth`, its market cap, price and deepest pool's liquidity now, read as brainchain_token_market_cap reads them;
 * `priorEvents`, what this log held for the token before; and, for a token a source names only by symbol, `matches`, the
 * tokens with an address that the log knows by that symbol. Two tokens can share a symbol, so the steps and the worth are
 * read only for a symbol that names exactly one. The steps and the worth are read side by side, each within `ms`, and one
 * that is missing says why in `unread` or `worthMissing`.
 */
export function eventContext({ log, readers, wallets, times, worth, ms = CONTEXT_MS, patience = ms, say }: ContextOptions): (event: WatchEvent) => Reading {
  const full: TimelineReaders = { ...readers, custody: async () => custodyFromLog(log), listed: async () => [] };
  return (event) => {
    const priorEvents = log
      .forToken(event)
      .filter(({ id }) => id < event.id)
      .map(({ id, kind, at, observedAt, baseline }) => ({ id, kind, at, observedAt, ...(baseline ? { baseline } : {}) }));
    let target = event.token.address ? getAddress(event.token.address) : undefined;
    let matches: { address: string; symbol: string | null; name: string | null; kinds: string[] }[] | undefined;
    if (!target && event.token.symbol) {
      const symbol = event.token.symbol.toUpperCase();
      const byAddress = new Map<string, { address: string; symbol: string | null; name: string | null; kinds: Set<string> }>();
      for (const other of log.all()) {
        if (!other.token.address || other.token.symbol?.toUpperCase() !== symbol) continue;
        const key = other.token.address.toLowerCase();
        const entry = byAddress.get(key) ?? { address: other.token.address, symbol: other.token.symbol, name: other.token.name, kinds: new Set<string>() };
        entry.kinds.add(other.kind);
        byAddress.set(key, entry);
      }
      matches = [...byAddress.values()].map(({ kinds, ...entry }) => ({ ...entry, kinds: [...kinds] }));
      if (matches.length === 1) target = getAddress(matches[0]!.address);
    }
    const context: Record<string, unknown> = { ...(matches ? { matches } : {}), priorEvents };
    if (!target) {
      const missing = matches
        ? `${matches.length === 0 ? "No token in the log goes" : `${matches.length} tokens in the log go`} by this symbol with a contract address, so its worth was not read.`
        : "The source gives no contract address for this token, so its worth was not read.";
      const whole = { ...context, worth: null, worthMissing: missing };
      return { now: () => whole, done: Promise.resolve(whole) };
    }
    const late = (what: string) => new LateError(`${what} was not read within ${ms / 1000} seconds.`);
    const before = Date.parse(event.at ?? event.observedAt);
    // Each part goes into the context the moment it is read, so what is ready can go out before the rest.
    const parts: Record<string, Record<string, unknown>> = {};
    // The worth first: both read the same endpoints, and the worth is what a reader wants soonest.
    const worthRead = worth ? patiently(() => within(ms, worth(target), late("The market cap")), Date.now() + patience) : Promise.reject(new LateError("This watcher reads no market cap."));
    const timeline = () => within(ms, tokenTimeline(full, target, wallets, times), late("The token timeline"));
    const steps = worthRead.then(timeline, timeline).then(
      (board) => (parts.priorTraces = { priorTraces: board.steps.filter((step) => Date.parse(step.at) < before), ...(board.unread.length ? { unread: board.unread } : {}) }),
      (error: unknown) => {
        if (why(error) === UNREAD) say?.(`event ${event.id}: the token timeline could not be read: ${describe(error)}`);
        parts.priorTraces = { priorTraces: null, unread: [why(error)] };
      },
    );
    const value = worthRead.then(
      (board) => (parts.worth = { worth: "chain" in board ? worthOf(board) : board }),
      (error: unknown) => {
        if (why(error) === UNREAD) say?.(`event ${event.id}: the market cap could not be read: ${describe(error)}`);
        parts.worth = { worth: null, worthMissing: why(error) };
      },
    );
    const now = () => {
      const pending = ["worth", "priorTraces"].filter((part) => !parts[part]);
      return { ...context, ...parts.priorTraces, ...parts.worth, ...(pending.length ? { pending } : {}) };
    };
    return { now, done: Promise.all([steps, value]).then(now) };
  };
}

/** What the worth reads keep between restarts: each token's pool index and the block its contract was created in. */
export interface WorthKept {
  index: CapKept["index"];
  created: Map<string, bigint>;
}

/** Reads the kept pool indexes and creation blocks, or starts empty when the file is missing or cut off. */
export function loadWorth(path: string): WorthKept {
  const kept: WorthKept = { index: new Map(), created: new Map() };
  if (!existsSync(path)) return kept;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as { index?: Record<string, { from: string; through: string; pools: (Omit<Pool, "created"> & { created: string })[] }>; created?: Record<string, string> };
    for (const [key, { from, through, pools }] of Object.entries(saved.index ?? {})) {
      kept.index.set(key, { from: BigInt(from), through: BigInt(through), pools: pools.map((pool) => ({ ...pool, created: BigInt(pool.created) })) });
    }
    for (const [address, block] of Object.entries(saved.created ?? {})) kept.created.set(address, BigInt(block));
  } catch {
    return { index: new Map(), created: new Map() };
  }
  return kept;
}

/** Writes the kept pool indexes and creation blocks whole, through a temporary file, so a crash leaves the old file. */
export function saveWorth(path: string, kept: WorthKept): void {
  const text = (value: bigint) => value.toString();
  const index = Object.fromEntries([...kept.index].map(([key, { from, through, pools }]) => [key, { from: text(from), through: text(through), pools: pools.map((pool) => ({ ...pool, created: text(pool.created) })) }]));
  const created = Object.fromEntries([...kept.created].map(([address, block]) => [address, text(block)]));
  writeFileSync(`${path}.tmp`, JSON.stringify({ index, created }));
  renameSync(`${path}.tmp`, path);
}

/** How many times a read that an endpoint asked to wait is tried in all. */
export const PATIENT_TRIES = 6;

/**
 * A read that an endpoint asked to wait is tried again once the wait is over, as long as that is before `until`; the
 * blocks already read are kept, so the next try starts where this one stopped.
 */
export async function patiently<T>(read: () => Promise<T>, until: number, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await read();
    } catch (error) {
      const wait = backoffIn(error);
      if (!wait || wait.until >= until || tries >= PATIENT_TRIES) throw error;
      await sleep(Math.max(0, wait.until - Date.now()) + 250);
    }
  }
}

/**
 * The block a contract was created in, found by halving on whether it had code: about 27 reads of state and none of logs,
 * which an archive node answers at once. Nothing when the contract has no code now or the halving fails; a search for its
 * pools then starts from the chain's first block, as it would without it.
 */
export async function createdIn(reader: ChainHistory, contract: Address, newest: bigint): Promise<bigint | undefined> {
  const has = async (block: bigint) => {
    const code = await reader.getCode({ address: contract, blockNumber: block });
    return code !== undefined && code !== "0x";
  };
  try {
    if (!(await has(newest))) return undefined;
    let [low, high] = [0n, newest];
    while (low < high) {
      const middle = (low + high) / 2n;
      if (await has(middle)) high = middle;
      else low = middle + 1n;
    }
    return low;
  } catch {
    return undefined;
  }
}

/** Runs a timeline's chain reads against the watcher's own reader, so they share its pace and its count of requests. */
export const chainTurn = (reader: ChainHistory) => <T>(read: (reader: ChainHistory) => Promise<T>) => read(reader);
