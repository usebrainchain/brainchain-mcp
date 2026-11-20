import { getAddress } from "viem";

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
