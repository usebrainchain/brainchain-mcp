import { getAddress } from "viem";

import { robinhoodPageName } from "../dataset/sources.js";
import { label } from "../history.js";
import { COINGECKO, GATE, KUCOIN, LIFI, ROBINHOOD_PAGES, ROBINHOOD_PAIRS, type Source } from "../sightings.js";
import type { Found, Kind } from "./events.js";
import type { Requests } from "./http.js";
import type { Poller } from "./watcher.js";

export const INTERVALS = {
  "robinhood-pairs": 2 * 60_000,
  // Robinhood's CDN keeps the sitemap for an hour, so reading it more often finds nothing sooner.
  "robinhood-pages": 15 * 60_000,
  kucoin: 5 * 60_000,
  gate: 5 * 60_000,
  lifi: 5 * 60_000,
  // CoinGecko marks its list fresh for half an hour.
  coingecko: 30 * 60_000,
} as const;

/** A document read with the parser brainchain_token_sightings reads it with. A 304 is nothing new. */
async function read<T>(requests: Requests, name: string, source: Source<T>): Promise<{ value: T; commit: () => void } | undefined> {
  const got = await requests.get(name, source.url, { accept: "*/*", conditional: true });
  if (got.status === 304) return undefined;
  if (got.status !== 200) throw new Error(`${new URL(source.url).host} answered ${got.status}.`);
  return { value: source.parse({ status: 200, body: got.body }), commit: () => requests.commit(source.url, got) };
}

interface Named {
  symbol: string;
  name: string;
}

/** A list matched by contract address: a token appears when the list first carries its address. */
function byContract<T extends Named>(requests: Requests, name: keyof typeof INTERVALS, kind: Kind, sourceName: string, source: Source<Map<string, T>>, detail: (entry: T) => Record<string, unknown> = () => ({})): Poller {
  return {
    name,
    interval: INTERVALS[name],
    async poll(context) {
      const got = await read(requests, name, source);
      if (!got) return;
      const found: Found[] = [...got.value].flatMap(([contract, entry]) => {
        if (!/^0x[0-9a-f]{40}$/.test(contract)) return [];
        const symbol = label(entry.symbol, 20);
        const tokenName = label(entry.name, 60);
        return [{ kind, token: { address: getAddress(contract), symbol: symbol || null, name: tokenName || null }, source: sourceName, ref: source.url, at: null, detail: detail(entry) }];
      });
      await context.record(found);
      got.commit();
    },
  };
}

export const kucoin = (requests: Requests) => byContract(requests, "kucoin", "kucoin.listed", "KuCoin", KUCOIN, ({ deposits, withdrawals }) => ({ deposits, withdrawals }));
export const gate = (requests: Requests) => byContract(requests, "gate", "gate.listed", "Gate", GATE, ({ deposits, withdrawals }) => ({ deposits, withdrawals }));
export const lifi = (requests: Requests) => byContract(requests, "lifi", "lifi.listed", "LI.FI", LIFI);
export const coingecko = (requests: Requests) => byContract(requests, "coingecko", "coingecko.listed", "CoinGecko", COINGECKO);

interface PairsState {
  /** Whether each symbol's pair was tradable when last read. */
  tradable?: Record<string, boolean>;
}

/**
 * The pair list Robinhood serves to API clients: a pair that enters it, and a pair whose tradability changes, which is
 * when customers go from seeing a price to being able to trade, or back. The list leaves out most price-only pairs, which
 * only the sitemap shows, so a pair that enters it may have had a price on Robinhood's site before. Robinhood gives no
 * contract address, so the token is named by symbol and Robinhood's own name for it.
 */
export function robinhoodPairs(requests: Requests): Poller {
  const name = "robinhood-pairs";
  return {
    name,
    interval: INTERVALS[name],
    async poll(context) {
      const state = context.state as PairsState;
      const got = await read(requests, name, ROBINHOOD_PAIRS);
      if (!got) return;
      const before = state.tradable ?? {};
      const observed = new Date().toISOString();
      const found: Found[] = [];
      for (const [symbol, { name: assetName, tradable }] of got.value) {
        const token = { address: null, symbol, name: assetName ?? null };
        const ref = `${ROBINHOOD_PAIRS.url}#${symbol}`;
        found.push({ kind: "robinhood.pair_added", token, source: "Robinhood", ref, at: null, detail: { tradable, pairsRead: got.value.size } });
        if (symbol in before && before[symbol] !== tradable) {
          found.push({ kind: "robinhood.tradability_changed", token, source: "Robinhood", ref: `${ref}@${observed}`, at: null, detail: { tradable, was: before[symbol], pairsRead: got.value.size } });
        }
      }
      await context.record(found);
      // A pair missing from one answer keeps its last state, so a list that comes back short cannot hide a change.
      state.tradable = { ...before, ...Object.fromEntries([...got.value].map(([symbol, { tradable }]) => [symbol, tradable])) };
      got.commit();
    },
  };
}

/**
 * How often a page's name is read again: a name rarely changes, and a page that gave none or could not be read is asked
 * again sooner. A read takes at most `perPoll` pages, a second apart, and goes on at once while more are due.
 */
export const NAME_READS = { named: 24 * 3_600_000, unnamed: 3_600_000, perPoll: 20, gap: 1_000 };

export interface NamesState {
  /** Robinhood's name on each page, "" for a page that gave none, and when it was read. */
  names?: Record<string, { name: string; at: string }>;
  /** When a page last could not be read. */
  failed?: Record<string, string>;
}

const nap = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Robinhood's own name for the asset on each page its crypto sitemap has listed, for `GET /robinhood/names`: the sitemap
 * names no asset, and the name is what ties a page to one token among those that go by its symbol. Read on the sitemap's
 * cadence. From outside the US, Robinhood sends a reader to its regional pages, which have no page for an asset listed
 * only in the US, so those give "".
 */
export function robinhoodNames(symbols: () => readonly string[], fetchImpl: typeof fetch, { clock = Date.now, sleep = nap } = {}): Poller {
  const name = "robinhood-names";
  return {
    name,
    interval: INTERVALS["robinhood-pages"],
    async poll(context) {
      const state = context.state as NamesState;
      const names = (state.names ??= {});
      const failed = (state.failed ??= {});
      const now = clock();
      const since = (at: string | undefined) => (at ? now - Date.parse(at) : Infinity);
      const due = symbols().filter((symbol) => since(failed[symbol]) >= NAME_READS.unnamed && since(names[symbol]?.at) >= (names[symbol]?.name ? NAME_READS.named : NAME_READS.unnamed));
      // Pages never read go first, then the longest unread.
      due.sort((a, b) => (names[a]?.at ?? "").localeCompare(names[b]?.at ?? ""));
      const batch = due.slice(0, NAME_READS.perPoll);
      let error: unknown;
      for (const [i, symbol] of batch.entries()) {
        if (i > 0) await sleep(NAME_READS.gap);
        try {
          names[symbol] = { name: await robinhoodPageName(symbol, fetchImpl), at: new Date(clock()).toISOString() };
          delete failed[symbol];
        } catch (cause) {
          error = cause;
          failed[symbol] = new Date(clock()).toISOString();
        }
      }
      if (batch.length > 0 && batch.every((symbol) => symbol in failed)) throw error;
      return due.length > batch.length;
    },
  };
}

/** Robinhood's crypto sitemap: a symbol that gets a page. */
export function robinhoodPages(requests: Requests): Poller {
  const name = "robinhood-pages";
  return {
    name,
    interval: INTERVALS[name],
    async poll(context) {
      const got = await read(requests, name, ROBINHOOD_PAGES);
      if (!got) return;
      await context.record(
        [...got.value].map((symbol) => ({ kind: "robinhood.page_added", token: { address: null, symbol, name: null }, source: "Robinhood", ref: `https://robinhood.com/us/en/crypto/${symbol}/`, at: null, detail: {} })),
      );
      got.commit();
    },
  };
}
