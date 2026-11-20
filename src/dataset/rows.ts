import { getAddress, zeroAddress } from "viem";

import type { WatchEvent } from "../watch/events.js";
import type { MakerRef, OutcomeRow, StepRow } from "./format.js";

/** A token with a trace: any event about its contract but a new pool, or a step the job's own scans found. */
export interface Traced {
  token: string;
  symbols: Set<string>;
  names: Set<string>;
  sources: Set<string>;
  observedAt: string;
  baseline: boolean;
}

/** A contract address; ETH, which LI.FI lists at the zero address, is no token's contract. */
const isToken = (address: string | null): address is string => address !== null && /^0x[0-9a-fA-F]{40}$/.test(address) && address !== zeroAddress;

const LISTS: Record<string, "Trust Wallet" | "MetaMask"> = { "trustwallet.merged": "Trust Wallet", "metamask.merged": "MetaMask", "trustwallet.pr_opened": "Trust Wallet", "metamask.pr_opened": "MetaMask" };
const AGGREGATORS: Record<string, "LI.FI" | "CoinGecko"> = { "lifi.listed": "LI.FI", "coingecko.listed": "CoinGecko" };

/** Every traced token in the log, with what the sources call it. */
export function tracedIn(events: readonly WatchEvent[]): Map<string, Traced> {
  const traced = new Map<string, Traced>();
  for (const event of events) {
    const { address, symbol, name } = event.token;
    if (!isToken(address) || event.kind === "pool.created") continue;
    const key = address.toLowerCase();
    let entry = traced.get(key);
    if (!entry) traced.set(key, (entry = { token: getAddress(address), symbols: new Set(), names: new Set(), sources: new Set(), observedAt: event.observedAt, baseline: event.baseline === true }));
    if (symbol) entry.symbols.add(symbol.toUpperCase());
    if (name) entry.names.add(name);
    entry.sources.add(event.source);
  }
  return traced;
}

const dated = (at: string, atFrom: NonNullable<StepRow["atFrom"]>) => ({ at, atFrom });
const flags = (event: WatchEvent) => (event.baseline ? { backfill: true as const } : {});
const makerOf = (detail: Record<string, unknown>): MakerRef | undefined => {
  const maker = detail.maker as MakerRef | undefined;
  return maker && typeof maker.wallet === "string" ? { ...(maker.name ? { name: maker.name } : {}), ...(maker.tag ? { tag: maker.tag } : {}), wallet: getAddress(maker.wallet) } : undefined;
};

/**
 * The steps the watcher's log records, one row for each. A source that dates a step gives `at`; one that dates nothing
 * gives `at` as when the watcher saw it, unless the step was already public when the watcher started, which gives `by`
 * instead. A list's file that was there at the start is dated by `listDates`, the merge of the pull request behind its
 * first commit, when that was read.
 */
export function stepsFromEvents(events: readonly WatchEvent[], listDates: ReadonlyMap<string, string>): StepRow[] {
  const rows: StepRow[] = [];
  for (const event of events) {
    const { address } = event.token;
    if (!isToken(address)) continue;
    const token = getAddress(address);
    const detail = event.detail;
    const observedAt = event.observedAt;
    const add = (row: Omit<StepRow, "token" | "observedAt" | "backfill">) => rows.push({ token, ...row, observedAt, ...flags(event) });
    const undated = () => (event.baseline ? { by: observedAt } : dated(observedAt, "observed"));
    switch (event.kind) {
      case "bitgo.merged":
        add({ step: "custody", source: "BitGo", ...(event.at ? dated(event.at, "push") : undated()), ref: event.ref, ...(typeof detail.id === "string" ? { id: detail.id } : {}) });
        break;
      case "bitgo.pr_opened":
        if (event.at) add({ step: "custody_pr", source: "BitGo", ...dated(event.at, "source"), ref: event.ref });
        break;
      case "bitgo.released":
        add({
          step: "custody_release",
          source: "BitGo",
          ...(event.baseline ? { by: typeof detail.by === "string" ? detail.by : observedAt } : dated(observedAt, "observed")),
          ref: event.ref,
          ...(typeof detail.version === "string" ? { version: detail.version } : {}),
        });
        break;
      case "trustwallet.merged":
      case "metamask.merged": {
        const source = LISTS[event.kind]!;
        const since = listDates.get(`${source}|${token.toLowerCase()}`);
        add({ step: "listing", source, ...(event.at ? dated(event.at, "push") : since ? dated(since, "push") : undated()), ref: typeof detail.link === "string" ? detail.link : event.ref });
        break;
      }
      case "trustwallet.pr_opened":
      case "metamask.pr_opened":
        if (event.at) add({ step: "listing_pr", source: LISTS[event.kind]!, ...dated(event.at, "source"), ref: event.ref });
        break;
      case "lifi.listed":
      case "coingecko.listed":
        add({ step: "aggregator", source: AGGREGATORS[event.kind]!, ...undated(), ref: event.ref });
        break;
      case "maker.approval": {
        const maker = makerOf(detail);
        if (!maker || !event.at || typeof detail.block !== "number") break;
        add({ step: "approval", source: "Robinhood Chain", ...dated(event.at, "block"), block: detail.block, transaction: String(detail.transaction), maker, spender: String(detail.spender), confirmed: detail.confirmed === true });
        break;
      }
      case "maker.pool_queued": {
        const maker = makerOf(detail);
        if (!maker || !event.at || typeof detail.block !== "number") break;
        add({
          step: "pool_queued",
          source: "Robinhood Chain",
          ...dated(event.at, "block"),
          block: detail.block,
          transaction: String(detail.transaction),
          maker,
          pool: String(detail.pool),
          pairedWith: String(detail.pairedWith),
          confirmed: detail.confirmed === true,
        });
        break;
      }
    }
  }
  return rows;
}

/** A name with case, spacing and punctuation folded away, so "Cash Cat" and "CASH-CAT" compare equal. */
export const folded = (name: string) => name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * The traced token a venue's symbol stands for, when it can be told. With the venue's own name for the asset, the token
 * must go by the symbol and by that name; without one, the symbol must name one traced token alone and no venue may give
 * the symbol a name the token does not have. Two tokens can share a symbol, and a token on Robinhood Chain that calls
 * itself DOGE is not Dogecoin, so anything less is left out.
 */
export function attribute(symbol: string, venueName: string | undefined, traced: ReadonlyMap<string, Traced>, knownNames: ReadonlyMap<string, string>): { token: string; match: "name" | "symbol" } | undefined {
  const wanted = symbol.toUpperCase();
  const candidates = [...traced.values()].filter(({ symbols }) => symbols.has(wanted));
  const named = venueName || knownNames.get(wanted);
  if (named) {
    const hits = candidates.filter(({ names }) => [...names].some((name) => folded(name) === folded(named)));
    return hits.length === 1 ? { token: hits[0]!.token, match: "name" } : undefined;
  }
  return candidates.length === 1 ? { token: candidates[0]!.token, match: "symbol" } : undefined;
}

/** When each venue says trading in an asset opened, in milliseconds, by the venue's code for it. */
export interface TradingStarts {
  kucoin: ReadonlyMap<string, number>;
  gate: ReadonlyMap<string, number>;
}

/**
 * The outcomes: KuCoin and Gate by the contract they list on Robinhood Chain, dated by the trading start the venue
 * publishes when it had opened by the time the watcher saw the listing; Robinhood's sitemap and tradable pairs by symbol
 * (see `attribute`), dated when the watcher first saw them. One already there when the watcher first read the venue is
 * "listed by" that time.
 */
export function outcomesFromEvents(events: readonly WatchEvent[], traced: ReadonlyMap<string, Traced>, starts: TradingStarts): OutcomeRow[] {
  const rows: OutcomeRow[] = [];
  const pairNames = new Map<string, string>();
  for (const event of events) if (event.kind === "robinhood.pair_added" && event.token.symbol && event.token.name) pairNames.set(event.token.symbol.toUpperCase(), event.token.name);
  const undated = (event: WatchEvent) => (event.baseline ? { by: event.observedAt } : { at: event.observedAt, atFrom: "observed" as const });
  for (const event of events) {
    const flags = event.baseline ? { backfill: true as const } : {};
    const { address, symbol } = event.token;
    if ((event.kind === "kucoin.listed" || event.kind === "gate.listed") && address) {
      const venue = event.kind === "kucoin.listed" ? "KuCoin" : "Gate";
      const start = symbol ? (venue === "KuCoin" ? starts.kucoin : starts.gate).get(symbol.toUpperCase()) : undefined;
      const opened = start !== undefined && start <= Date.parse(event.observedAt);
      rows.push({
        token: getAddress(address),
        outcome: venue === "KuCoin" ? "kucoin" : "gate",
        venue,
        ...(opened ? { at: new Date(start).toISOString(), atFrom: "source" as const } : undated(event)),
        match: "contract",
        ...(symbol ? { symbol } : {}),
        ...(event.token.name ? { name: event.token.name } : {}),
        ...(start !== undefined ? { tradingStart: new Date(start).toISOString() } : {}),
        ref: event.ref,
        observedAt: event.observedAt,
        ...flags,
      });
      continue;
    }
    if (!symbol || address) continue;
    const pair = event.kind === "robinhood.pair_added" || event.kind === "robinhood.tradability_changed";
    if (event.kind !== "robinhood.page_added" && !(pair && event.detail.tradable === true)) continue;
    if (event.kind === "robinhood.tradability_changed" && event.baseline) continue;
    const found = attribute(symbol, pair ? (event.token.name ?? undefined) : undefined, traced, pairNames);
    if (!found) continue;
    rows.push({
      token: found.token,
      outcome: pair ? "robinhood_tradable" : "robinhood_page",
      venue: "Robinhood",
      ...undated(event),
      match: found.match,
      symbol: symbol.toUpperCase(),
      ...(pair && event.token.name ? { name: event.token.name } : {}),
      ref: event.ref.split("@")[0]!,
      observedAt: event.observedAt,
      ...flags,
    });
  }
  return rows;
}
