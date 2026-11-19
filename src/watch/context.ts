import { getAddress, type Address } from "viem";

import { BITGO_START, CustodyError, within, type CustodyAddition, type CustodyBoard } from "../custody.js";
import { ANSWER_MS, ChainError, type ChainHistory } from "../history.js";
import type { MarketCapBoard } from "../marketcap.js";
import { SightingsError } from "../sightings.js";
import type { MakerWallet } from "../makers.js";
import { tokenTimeline, type TimelineReaders } from "../timeline.js";
import type { EventLog, WatchEvent } from "./events.js";
import { backoffIn, describe } from "./watcher.js";

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
  worth?: (token: Address) => Promise<MarketCapBoard>;
  ms?: number;
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
export function eventContext({ log, readers, wallets, times, worth, ms = CONTEXT_MS, say }: ContextOptions): (event: WatchEvent) => Promise<Record<string, unknown>> {
  const full: TimelineReaders = { ...readers, custody: async () => custodyFromLog(log), listed: async () => [] };
  return async (event) => {
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
      return { ...context, worth: null, worthMissing: missing };
    }
    const late = (what: string) => new LateError(`${what} was not read within ${ms / 1000} seconds.`);
    const before = Date.parse(event.at ?? event.observedAt);
    const [steps, value] = await Promise.allSettled([
      within(ms, tokenTimeline(full, target, wallets, times), late("The token timeline")),
      worth ? within(ms, worth(target), late("The market cap")) : Promise.reject(new LateError("This watcher reads no market cap.")),
    ]);
    for (const [what, read] of [["token timeline", steps], ["market cap", value]] as const) {
      if (read.status === "rejected" && why(read.reason) === UNREAD) say?.(`event ${event.id}: the ${what} could not be read: ${describe(read.reason)}`);
    }
    return {
      ...context,
      ...(steps.status === "fulfilled"
        ? { priorTraces: steps.value.steps.filter((step) => Date.parse(step.at) < before), ...(steps.value.unread.length ? { unread: steps.value.unread } : {}) }
        : { priorTraces: null, unread: [why(steps.reason)] }),
      ...(value.status === "fulfilled" ? { worth: worthOf(value.value) } : { worth: null, worthMissing: why(value.reason) }),
    };
  };
}

/** Runs a timeline's chain reads against the watcher's own reader, so they share its pace and its count of requests. */
export const chainTurn = (reader: ChainHistory) => <T>(read: (reader: ChainHistory) => Promise<T>) => read(reader);
