import { getAddress, zeroAddress } from "viem";

import { folded } from "../dataset/rows.js";
import { label } from "../history.js";
import type { EventLog, EventToken, Found, WatchEvent } from "./events.js";
import type { Requests } from "./http.js";
import type { Poller } from "./watcher.js";

/** Robinhood Chain's first block. A market a venue opened before it is not a market for one of its tokens. */
export const CHAIN_START = Date.parse("2026-04-30T16:52:11Z");

/** A Robinhood Chain token the log knows by address, with every symbol and name its sources give it. */
export interface KnownToken {
  address: string;
  symbols: Set<string>;
  names: Set<string>;
}

/** The tokens the log knows, by address and by symbol, and the names each venue's own announcements give a symbol. */
export interface Universe {
  byAddress: Map<string, KnownToken>;
  bySymbol: Map<string, KnownToken[]>;
  /** By venue, then symbol: the name the venue gave the asset in an announcement, as "Pons" in "Bitget lists Pons (PONS) in the Innovation Zone". */
  named: Map<string, Map<string, string>>;
}

const isToken = (address: string | null): address is string => address !== null && /^0x[0-9a-fA-F]{40}$/.test(address) && address.toLowerCase() !== zeroAddress;

export function universeOf(events: readonly WatchEvent[]): Universe {
  const byAddress = new Map<string, KnownToken>();
  const named = new Map<string, Map<string, string>>();
  for (const { kind, token, source, detail } of events) {
    if (kind === "venue.announced" && token.symbol && typeof detail.venueName === "string") {
      if (!named.has(source)) named.set(source, new Map());
      named.get(source)!.set(token.symbol.toUpperCase(), detail.venueName);
    }
    if (!isToken(token.address)) continue;
    const key = token.address.toLowerCase();
    let known = byAddress.get(key);
    if (!known) byAddress.set(key, (known = { address: getAddress(key), symbols: new Set(), names: new Set() }));
    if (token.symbol) known.symbols.add(token.symbol.toUpperCase());
    if (token.name) known.names.add(token.name);
  }
  const bySymbol = new Map<string, KnownToken[]>();
  for (const known of byAddress.values()) for (const symbol of known.symbols) bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), known]);
  return { byAddress, bySymbol, named };
}

/** The universe of a log, worked out again only when the log has grown. */
export function universeFrom(log: EventLog): () => Universe {
  let size = -1;
  let universe: Universe | undefined;
  return () => {
    if (!universe || log.size !== size) {
      universe = universeOf(log.all());
      size = log.size;
    }
    return universe;
  };
}

/** What a venue says of an asset, by its code for it. */
export interface Asset {
  base: string;
  name?: string;
  /** The asset's contract on Robinhood Chain, as the venue gives it. */
  contract?: string;
  /** A contract the venue gives without naming its chain: only a token the log knows at that address matches it. */
  anyChain?: string;
  /** The venue names the asset's chains, and Robinhood Chain is not one of them. */
  elsewhere?: boolean;
  /** When the venue says trading in it opened, in milliseconds. */
  opens?: number;
}

/** How a venue's asset was tied to a Robinhood Chain token: its contract, the venue's name for it, or the symbol alone. */
export type Match = "contract" | "name" | "symbol";

export interface Matched {
  token: EventToken;
  match: Match;
  /** The venue's own name for the asset, where it gives one. */
  venueName?: string;
  /** For a symbol alone: how many tokens in the log go by it. */
  candidates?: number;
}

/**
 * The Robinhood Chain token a venue's asset is, when it can be told. A contract on Robinhood Chain settles it. A venue's
 * name must be a name the log has for exactly one token with the symbol, and a name, or contracts on other chains only,
 * that no such token has rules it out. With neither, the symbol is all there is: the token goes by symbol with no address,
 * and the match is marked as resting on the symbol alone. A market that opened before the chain began is never one.
 */
export function matchAsset(universe: Universe, asset: Asset): Matched | undefined {
  if (asset.opens !== undefined && asset.opens < CHAIN_START) return undefined;
  const symbol = label(asset.base, 20).toUpperCase();
  if (!symbol) return undefined;
  const venueName = asset.name ? label(asset.name, 60) : "";
  const byContract = (address: string): Matched => {
    const known = universe.byAddress.get(address.toLowerCase());
    return { token: { address: getAddress(address.toLowerCase()), symbol, name: venueName || [...(known?.names ?? [])][0] || null }, match: "contract", ...(venueName ? { venueName } : {}) };
  };
  if (asset.contract && isToken(asset.contract)) return byContract(asset.contract);
  if (asset.anyChain && isToken(asset.anyChain)) return universe.byAddress.has(asset.anyChain.toLowerCase()) ? byContract(asset.anyChain) : undefined;
  const candidates = universe.bySymbol.get(symbol) ?? [];
  if (asset.elsewhere || candidates.length === 0) return undefined;
  if (venueName) {
    const hits = candidates.filter(({ names }) => [...names].some((name) => folded(name) === folded(venueName)));
    return hits.length === 1 ? { token: { address: hits[0]!.address, symbol, name: venueName }, match: "name", venueName } : undefined;
  }
  return { token: { address: null, symbol, name: null }, match: "symbol", candidates: candidates.length };
}

export type MarketStatus = "pre-trading" | "auction" | "trading" | "halted";
export type MarketType = "spot" | "perpetual" | "futures";

/** One market as a venue lists it. */
export interface Market extends Asset {
  id: string;
  quote: string;
  type: MarketType;
  status: MarketStatus;
  /** The venue's own word for the status. */
  venueStatus: string;
  /** Where to check it: the venue's documented request for this market alone, or its list with the market's id. */
  ref: string;
}

/** A venue's market list: the documents it is read from and how. */
export interface VenueList {
  /** The poller's name. */
  name: string;
  /** The venue as events name it, such as Binance Futures. */
  venue: string;
  interval: number;
  /** Reads the markets with `get`, which answers a document's body and throws on anything but a 200. Throws when an answer is not the list. */
  read(get: (url: string) => Promise<string>): Promise<Market[]>;
}

const RANK: Record<MarketStatus, number> = { halted: 0, "pre-trading": 1, auction: 2, trading: 3 };
const best = (markets: readonly Market[]) => markets.reduce((top, market) => (RANK[market.status] > RANK[top] ? market.status : top), "halted" as MarketStatus);
const iso = (ms: number) => new Date(ms).toISOString();

interface MarketsState {
  /** Each asset the venue lists, by market type and the venue's code: the market first seen for it and its best status. */
  assets?: Record<string, { market: string; status: MarketStatus }>;
}

/**
 * Keeps the bodies of documents a host gave validators for, so a 304 can be read as the body it stands for. The bodies are
 * kept in memory only: after a restart the first request for each is made without validators.
 */
export function documents(requests: Requests, source: string, accept = "application/json") {
  const kept = new Map<string, string>();
  return async (url: string) => {
    // Validators kept from before a restart stand for a body no longer in memory, so they are not sent.
    if (!kept.has(url)) delete requests.validators[url];
    const got = await requests.get(source, url, { accept, conditional: true });
    if (got.status === 304 && kept.has(url)) return kept.get(url)!;
    if (got.status !== 200) throw new Error(`${new URL(url).host} answered ${got.status}.`);
    if (got.validators) {
      kept.set(url, got.body);
      requests.commit(url, got);
    }
    return got.body;
  };
}

/**
 * A venue's markets: an asset that gets its first market of a type, spot or perpetual, and a change in the best status of
 * its markets of that type, such as from an opening auction to trading. A new quote for an asset already listed is not a
 * listing. What the venue says of an asset in one market, its name or contract, holds for its markets of every type.
 * An asset that was on the venue before the log knew its token is recorded once the log does, as part of the baseline.
 */
export function marketPoller(requests: Requests, list: VenueList, tokens: () => Universe): Poller {
  const get = documents(requests, list.name);
  return {
    name: list.name,
    interval: list.interval,
    async poll(context) {
      const state = context.state as MarketsState;
      const now = Date.now();
      const markets = await list.read(get);
      if (markets.length === 0) throw new Error(`${list.venue} answered with no markets.`);
      const universe = tokens();
      const assets = state.assets ?? {};
      const first = context.baseline || !state.assets;
      const said = new Map<string, Asset>();
      for (const market of markets) {
        const base = market.base.toUpperCase();
        const known = said.get(base) ?? { base };
        said.set(base, {
          ...known,
          ...(!known.name && market.name ? { name: market.name } : {}),
          ...(!known.contract && market.contract ? { contract: market.contract } : {}),
          ...(known.elsewhere || market.elsewhere ? { elsewhere: true } : {}),
          ...(market.opens !== undefined && (known.opens === undefined || market.opens < known.opens) ? { opens: market.opens } : {}),
        });
      }
      const groups = new Map<string, Market[]>();
      for (const market of markets) {
        const key = `${market.type}:${market.base.toUpperCase()}`;
        groups.set(key, [...(groups.get(key) ?? []), market]);
      }
      const found: Found[] = [];
      for (const [key, group] of groups) {
        const status = best(group);
        const kept = assets[key];
        const sorted = [...group].sort((a, b) => (a.opens ?? Infinity) - (b.opens ?? Infinity) || a.id.localeCompare(b.id));
        const lead = (kept && group.find(({ id }) => id === kept.market)) ?? sorted[0]!;
        const asset = said.get(lead.base.toUpperCase())!;
        const announced = universe.named.get(list.venue)?.get(asset.base);
        const matched = matchAsset(universe, { ...asset, ...(!asset.name && announced ? { name: announced } : {}) });
        if (!kept) assets[key] = { market: lead.id, status };
        if (!matched) {
          if (kept) kept.status = status;
          continue;
        }
        const opens = sorted.find(({ opens }) => opens !== undefined)?.opens;
        const detail = {
          market: lead.id,
          type: lead.type,
          quote: lead.quote,
          status,
          venueStatus: lead.venueStatus,
          ...(group.length > 1 ? { markets: sorted.map(({ id }) => id) } : {}),
          match: matched.match,
          ...(matched.match === "symbol" ? { unconfirmed: true, candidates: matched.candidates } : {}),
          ...(matched.venueName ? { venueName: matched.venueName } : {}),
          ...(opens !== undefined ? { opens: iso(opens) } : {}),
        };
        const listed: Found = { kind: "venue.listed", token: matched.token, source: list.venue, ref: lead.ref, at: opens !== undefined && opens <= now ? iso(opens) : null, detail };
        // A market that was there before the watcher, tied by a symbol or a name alone and with no time to place it after
        // the chain began, may be the asset's market on another chain: Upbit's Chainlink is not Robinhood Chain's bridged
        // ChainLink. It is not kept. A new one is reported, with its match.
        const quiet = matched.match !== "contract" && opens === undefined;
        if (!kept) {
          if (!first) found.push(listed);
          else if (!quiet) found.push({ ...listed, baseline: true });
          continue;
        }
        // Already on the venue: written once as part of the baseline, for a token the log has come to know since.
        if (!quiet) found.push({ ...listed, baseline: true });
        if (!first && kept.status !== status) {
          found.push({ kind: "venue.status_changed", token: matched.token, source: list.venue, ref: `${lead.ref}@${iso(now)}`, at: null, detail: { ...detail, was: kept.status } });
        }
        kept.status = status;
      }
      await context.record(found);
      state.assets = assets;
    },
  };
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {});
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
/** A time in milliseconds as a venue writes it, as a number or a string of digits; nothing for none or zero. */
const ms = (value: unknown) => {
  const n = typeof value === "number" ? value : /^\d{10,16}$/.test(text(value)) ? Number(text(value)) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const listOf = (value: unknown, venue: string): Record<string, unknown>[] => {
  if (!Array.isArray(value)) throw new Error(`${venue} did not answer with its markets.`);
  return value.map(record);
};
const json = (body: string) => JSON.parse(body) as unknown;
const at = (ms: number | undefined) => (ms === undefined ? {} : { opens: ms });

const COINBASE = "https://api.exchange.coinbase.com";
/** Coinbase Exchange's products, with each asset's name and its contract on Robinhood Chain from its currencies. */
export const COINBASE_MARKETS: VenueList = {
  name: "coinbase-markets",
  venue: "Coinbase",
  interval: 60_000,
  async read(get) {
    const [products, currencies] = await Promise.all([get(`${COINBASE}/products`), get(`${COINBASE}/currencies`)]);
    const byId = new Map(listOf(json(currencies), "Coinbase").map((currency) => [text(currency.id).toUpperCase(), currency]));
    return listOf(json(products), "Coinbase").flatMap((product) => {
      if (product.status === "delisted") return [];
      const base = text(product.base_currency).toUpperCase();
      const currency = byId.get(base);
      const networks = array(currency?.supported_networks).map(record);
      const robinhood = networks.find(({ id }) => id === "robinhood");
      const contract = text(robinhood?.contract_address);
      const status: MarketStatus =
        product.status !== "online" || product.trading_disabled === true || product.cancel_only === true ? "halted" : product.auction_mode === true ? "auction" : product.post_only === true ? "pre-trading" : "trading";
      const flags = [["auction_mode", "auction"], ["post_only", "post only"], ["limit_only", "limit only"], ["cancel_only", "cancel only"], ["trading_disabled", "trading disabled"]].filter(([field]) => product[field!] === true).map(([, word]) => word);
      const id = text(product.id);
      return [
        {
          id,
          base,
          quote: text(product.quote_currency).toUpperCase(),
          type: "spot" as const,
          status,
          venueStatus: [text(product.status), ...flags].join(", "),
          ...(text(currency?.name) ? { name: text(currency?.name) } : {}),
          ...(contract ? { contract } : {}),
          ...(networks.length > 0 && !robinhood ? { elsewhere: true } : {}),
          ref: `${COINBASE}/products/${encodeURIComponent(id)}`,
        },
      ];
    });
  },
};

const KRAKEN = "https://api.kraken.com/0/public/AssetPairs";
const KRAKEN_STATUS: Record<string, MarketStatus> = { online: "trading", limit_only: "trading", post_only: "pre-trading", cancel_only: "halted", reduce_only: "halted", delisted: "halted", maintenance: "halted" };
/** Kraken's spot pairs. Kraken gives no name or contract for an asset, so its markets are matched by symbol. */
export const KRAKEN_MARKETS: VenueList = {
  name: "kraken-markets",
  venue: "Kraken",
  interval: 60_000,
  async read(get) {
    const answer = record(json(await get(KRAKEN)));
    if (array(answer.error).length > 0 || typeof answer.result !== "object" || answer.result === null) throw new Error("Kraken did not answer with its markets.");
    return Object.values(answer.result as Record<string, unknown>)
      .map(record)
      .flatMap((pair) => {
        const [base, quote] = text(pair.wsname).split("/");
        if (!base || !quote || pair.aclass_base !== "currency") return [];
        const status = text(pair.status);
        return [{ id: text(pair.altname), base: base.toUpperCase(), quote: quote.toUpperCase(), type: "spot" as const, status: KRAKEN_STATUS[status] ?? "halted", venueStatus: status, ref: `${KRAKEN}?pair=${encodeURIComponent(text(pair.altname))}` }];
      });
  },
};

const BINANCE_FUTURES = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const FUTURES_STATUS: Record<string, MarketStatus> = { TRADING: "trading", PENDING_TRADING: "pre-trading" };
/** Binance's USDⓈ-M futures on crypto assets, dated by the onboard date Binance gives each; stock and commodity contracts are left out. */
export const BINANCE_FUTURES_MARKETS: VenueList = {
  name: "binance-futures-markets",
  venue: "Binance Futures",
  interval: 60_000,
  async read(get) {
    return listOf(record(json(await get(BINANCE_FUTURES))).symbols, "Binance Futures").flatMap((symbol) => {
      if (symbol.underlyingType !== "COIN") return [];
      const status = text(symbol.status);
      return [
        {
          id: text(symbol.symbol),
          base: text(symbol.baseAsset).toUpperCase(),
          quote: text(symbol.quoteAsset).toUpperCase(),
          type: symbol.contractType === "PERPETUAL" ? ("perpetual" as const) : ("futures" as const),
          status: FUTURES_STATUS[status] ?? "halted",
          venueStatus: status,
          ...at(ms(symbol.onboardDate)),
          ref: `${BINANCE_FUTURES}#${encodeURIComponent(text(symbol.symbol))}`,
        },
      ];
    });
  },
};

/** Upbit's and Bithumb's lists share a shape: QUOTE-BASE markets with each asset's English name. */
function krwList(venue: string, url: string): VenueList["read"] {
  return async (get) =>
    listOf(json(await get(url)), venue).flatMap((entry) => {
      const [quote, base] = text(entry.market).split("-");
      if (!quote || !base) return [];
      return [{ id: text(entry.market), base: base.toUpperCase(), quote: quote.toUpperCase(), type: "spot" as const, status: "trading" as const, venueStatus: "listed", ...(text(entry.english_name) ? { name: text(entry.english_name) } : {}), ref: `${url}#${encodeURIComponent(text(entry.market))}` }];
    });
}

const UPBIT = "https://api.upbit.com/v1/market/all?is_details=true";
export const UPBIT_MARKETS: VenueList = { name: "upbit-markets", venue: "Upbit", interval: 60_000, read: krwList("Upbit", UPBIT) };
const BITHUMB = "https://api.bithumb.com/v1/market/all?isDetails=true";
export const BITHUMB_MARKETS: VenueList = { name: "bithumb-markets", venue: "Bithumb", interval: 60_000, read: krwList("Bithumb", BITHUMB) };

const BITGET = "https://api.bitget.com/api/v2";
const BITGET_SPOT: Record<string, MarketStatus> = { online: "trading", gray: "pre-trading" };
const BITGET_FUTURES: Record<string, MarketStatus> = { normal: "trading", listed: "pre-trading" };
/**
 * Bitget's spot pairs and USDT perpetuals, dated by the open time Bitget gives each, with each asset's contract on Robinhood
 * Chain from its coins; contracts on stocks and other real-world assets are left out.
 */
export const BITGET_MARKETS: VenueList = {
  name: "bitget-markets",
  venue: "Bitget",
  interval: 120_000,
  async read(get) {
    const data = (body: string) => {
      const answer = record(json(body));
      if (answer.code !== "00000") throw new Error("Bitget did not answer with its markets.");
      return listOf(answer.data, "Bitget");
    };
    const [symbols, coins, contracts] = (await Promise.all([get(`${BITGET}/spot/public/symbols`), get(`${BITGET}/spot/public/coins`), get(`${BITGET}/mix/market/contracts?productType=USDT-FUTURES`)])).map(data) as [Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[]];
    const chains = new Map(coins.map((coin) => [text(coin.coin).toUpperCase(), array(coin.chains).map(record)]));
    const identity = (base: string) => {
      const listed = chains.get(base) ?? [];
      const robinhood = listed.find(({ chain }) => /^robinhood/i.test(text(chain)));
      const contract = text(robinhood?.contractAddress);
      return { ...(contract ? { contract } : {}), ...(listed.length > 0 && !robinhood ? { elsewhere: true } : {}) };
    };
    return [
      ...symbols.map((symbol) => {
        const base = text(symbol.baseCoin).toUpperCase();
        const status = text(symbol.status);
        return { id: text(symbol.symbol), base, quote: text(symbol.quoteCoin).toUpperCase(), type: "spot" as const, status: BITGET_SPOT[status] ?? "halted", venueStatus: status, ...identity(base), ...at(ms(symbol.openTime)), ref: `${BITGET}/spot/public/symbols?symbol=${encodeURIComponent(text(symbol.symbol))}` };
      }),
      ...contracts.flatMap((contract) => {
        if (contract.isRwa === "YES") return [];
        const base = text(contract.baseCoin).toUpperCase();
        const status = text(contract.symbolStatus);
        return [
          {
            id: text(contract.symbol),
            base,
            quote: text(contract.quoteCoin).toUpperCase(),
            type: contract.symbolType === "delivery" ? ("futures" as const) : ("perpetual" as const),
            status: BITGET_FUTURES[status] ?? "halted",
            venueStatus: status,
            ...identity(base),
            ...at(ms(contract.launchTime) ?? ms(contract.openTime)),
            ref: `${BITGET}/mix/market/contracts?productType=USDT-FUTURES&symbol=${encodeURIComponent(text(contract.symbol))}`,
          },
        ];
      }),
    ];
  },
};

export const VENUE_LISTS = [COINBASE_MARKETS, KRAKEN_MARKETS, BINANCE_FUTURES_MARKETS, UPBIT_MARKETS, BITHUMB_MARKETS, BITGET_MARKETS] as const;

/** The hosts the market lists and announcements are read from, each held to this many requests an hour. */
export const VENUE_HOSTS = ["api.exchange.coinbase.com", "status.exchange.coinbase.com", "api.kraken.com", "blog.kraken.com", "fapi.binance.com", "api.upbit.com", "api.bithumb.com", "api.bitget.com"] as const;
export const VENUE_PER_HOUR = 300;
