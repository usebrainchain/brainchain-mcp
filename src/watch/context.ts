import { getAddress, type Address } from "viem";

import { BITGO_START, type CustodyAddition, type CustodyBoard } from "../custody.js";
import { ANSWER_MS, type ChainHistory } from "../history.js";
import type { MakerWallet } from "../makers.js";
import { tokenTimeline, type TimelineReaders } from "../timeline.js";
import type { EventLog, Found } from "./events.js";

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
  ms?: number;
}

/**
 * What goes with a new event: `priorTraces`, the token's dated public steps before the event, read by the token timeline;
 * `priorEvents`, what this log already holds for the token; and, for a token a source names only by symbol, `matches`, the
 * tokens with an address that the log knows by that symbol. Two tokens can share a symbol, so the steps are read only for a
 * symbol that names exactly one.
 */
export function eventContext({ log, readers, wallets, times, ms = CONTEXT_MS }: ContextOptions): (found: Found) => Promise<Record<string, unknown>> {
  const full: TimelineReaders = { ...readers, custody: async () => custodyFromLog(log), listed: async () => [] };
  return async (found) => {
    const priorEvents = log.forToken(found).map(({ id, kind, at, observedAt, baseline }) => ({ id, kind, at, observedAt, ...(baseline ? { baseline } : {}) }));
    let target = found.token.address ? getAddress(found.token.address) : undefined;
    let matches: { address: string; symbol: string | null; name: string | null; kinds: string[] }[] | undefined;
    if (!target && found.token.symbol) {
      const symbol = found.token.symbol.toUpperCase();
      const byAddress = new Map<string, { address: string; symbol: string | null; name: string | null; kinds: Set<string> }>();
      for (const event of log.all()) {
        if (!event.token.address || event.token.symbol?.toUpperCase() !== symbol) continue;
        const key = event.token.address.toLowerCase();
        const entry = byAddress.get(key) ?? { address: event.token.address, symbol: event.token.symbol, name: event.token.name, kinds: new Set<string>() };
        entry.kinds.add(event.kind);
        byAddress.set(key, entry);
      }
      matches = [...byAddress.values()].map(({ kinds, ...entry }) => ({ ...entry, kinds: [...kinds] }));
      if (matches.length === 1) target = getAddress(matches[0]!.address);
    }
    const context: Record<string, unknown> = { ...(matches ? { matches } : {}), priorEvents };
    if (!target) return context;
    const before = Date.parse(found.at ?? new Date().toISOString());
    let timer: NodeJS.Timeout | undefined;
    try {
      const board = await Promise.race([
        tokenTimeline(full, target as Address, wallets, times),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`The token timeline was not read within ${ms / 1000} seconds.`)), ms);
        }),
      ]);
      return { ...context, priorTraces: board.steps.filter((step) => Date.parse(step.at) < before), ...(board.unread.length ? { unread: board.unread } : {}) };
    } catch (error) {
      return { ...context, priorTraces: null, unread: [error instanceof Error ? error.message : String(error)] };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Runs a timeline's chain reads against the watcher's own reader, so they share its pace and its count of requests. */
export const chainTurn = (reader: ChainHistory) => <T>(read: (reader: ChainHistory) => Promise<T>) => read(reader);
