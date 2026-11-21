import { folded } from "../dataset/rows.js";
import { label } from "../history.js";
import type { Found } from "./events.js";
import { documents, matchAsset, type Matched, type Universe } from "./exchanges.js";
import type { Requests } from "./http.js";
import type { Poller } from "./watcher.js";

/** An asset an announcement names: its symbol, and the text beside the symbol that may be its name. */
export interface Named {
  symbol: string;
  /** The text the symbol follows in parentheses, as "Bitget lists Pons" in "Bitget lists Pons (PONS) in the Innovation Zone": the name is some last part of it. */
  before?: string;
  /** A name given whole, as "Solstice" in "SLX/USDT (Solstice)", or a name and code a page lists side by side. */
  name?: string;
}

/** One announcement as a venue publishes it. */
export interface Notice {
  /** What the venue calls it for good: its link, or its own id. */
  id: string;
  title: string;
  url: string;
  /** When the venue published it, in milliseconds. */
  at?: number;
  named: Named[];
  /** Contracts in its text, which match only a token the log knows at that address. */
  contracts?: string[];
  /** Contracts the text says are on Robinhood Chain, with the asset it names for each. */
  onChain?: { symbol: string; name: string; contract: string }[];
}

export interface NoticeSource {
  name: string;
  venue: string;
  interval: number;
  url: string;
  accept?: string;
  parse(body: string): Notice[];
}

/** The quote currencies and venue names that are never the asset an announcement is about. */
const NOT_ASSETS = new Set(["USDT", "USDC", "USD", "USD1", "USDE", "FDUSD", "EUR", "TRY", "KRW", "BRL", "GBP", "JPY", "AUD", "BTC", "ETH", "COINBASE", "KRAKEN", "BITHUMB", "BITGET", "UTC", "PST", "PDT", "API", "NEW"]);
/** An announcement about a contract that tracks a stock, a fund or a commodity, which no token here is. */
const OTHER_MARKETS = /\b(?:stocks?|tradfi|xstocks?|equit(?:y|ies)|etfs?|commodit(?:y|ies)|forex)\b/i;

/** One entry for each symbol, keeping the first name and the first text found beside it. */
function merged(entries: Iterable<Named>): Named[] {
  const found = new Map<string, Named>();
  for (const { symbol, before, name } of entries) {
    if (NOT_ASSETS.has(symbol)) continue;
    const known = found.get(symbol) ?? { symbol };
    found.set(symbol, { ...known, ...(before && !known.before ? { before } : {}), ...(name && !known.name ? { name } : {}) });
  }
  return [...found.values()];
}

/**
 * The assets a title names: a pair with a name after it, a symbol in parentheses after a name, or a pair alone. In a
 * post's text, `pairs` false keeps only symbols in parentheses, as a text mentions other pairs in passing.
 */
export function namedIn(title: string, { pairs = true } = {}): Named[] {
  const entries: Named[] = [];
  if (pairs) for (const match of title.matchAll(/\b([A-Z0-9]{2,15})\/[A-Z0-9]{2,6}\s*\(([^()]{2,60})\)/g)) entries.push({ symbol: match[1]!, name: match[2]!.trim() });
  for (const match of title.matchAll(/\(([A-Z0-9]{2,15})\)/g)) entries.push({ symbol: match[1]!, before: title.slice(Math.max(0, match.index! - 80), match.index!).trim() });
  if (pairs) for (const match of title.matchAll(/\b([A-Z0-9]{2,15}?)[/-]?(?:USDT|USDC|USD1|USD|EUR|TRY|KRW)\b/g)) entries.push({ symbol: match[1]! });
  return merged(entries);
}

/**
 * The tokens an announcement names. A contract the text says is on Robinhood Chain settles it, and so does one in it that
 * the log knows. Otherwise the symbol must be one a
 * token in the log goes by: with a name beside it, the name must be one the log has for exactly one such token, and a name
 * no such token has rules it out; with none, the token goes by the symbol alone, marked as such.
 */
export function matchNotice(universe: Universe, notice: Pick<Notice, "named" | "contracts" | "onChain">): Matched[] {
  const matched = new Map<string, Matched>();
  for (const { symbol, name, contract } of notice.onChain ?? []) {
    const hit = matchAsset(universe, { base: symbol, name, contract });
    if (hit) matched.set(hit.token.address!.toLowerCase(), hit);
  }
  for (const contract of notice.contracts ?? []) {
    const known = universe.byAddress.get(contract.toLowerCase());
    if (!known) continue;
    const hit = matchAsset(universe, { base: [...known.symbols][0] ?? "", anyChain: contract });
    if (hit) matched.set(hit.token.address!.toLowerCase(), hit);
  }
  for (const { symbol, before, name } of notice.named) {
    const candidates = universe.bySymbol.get(symbol.toUpperCase()) ?? [];
    if (candidates.length === 0 || candidates.some(({ address }) => matched.has(address.toLowerCase()))) continue;
    if (name) {
      const hit = matchAsset(universe, { base: symbol, name });
      if (hit) matched.set(hit.token.address!.toLowerCase(), hit);
      continue;
    }
    if (before) {
      const text = folded(before);
      const hits = candidates.flatMap((token) => {
        const named = [...token.names].find((known) => folded(known).length >= 2 && text.endsWith(folded(known)));
        return named ? [{ token, named }] : [];
      });
      if (hits.length === 1) matched.set(hits[0]!.token.address.toLowerCase(), { token: { address: hits[0]!.token.address, symbol: symbol.toUpperCase(), name: label(hits[0]!.named, 60) }, match: "name", venueName: label(hits[0]!.named, 60) });
      // A name stood beside the symbol and it is none of these tokens' names, or it fits more than one: no match.
      continue;
    }
    const hit = matchAsset(universe, { base: symbol });
    if (hit) matched.set(`symbol:${symbol.toUpperCase()}`, hit);
  }
  return [...matched.values()];
}

interface NoticesState {
  /** The ids of the announcements read before, newest last. */
  seen?: string[];
}

const KEEP_SEEN = 2_000;
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * A venue's announcements: one that names a Robinhood Chain token, for each token it names. What the venue published
 * before the watcher first read it is the baseline; an announcement already read that names a token the log has come to
 * know since is written to the baseline then. An announcement that names a token by its symbol alone is reported when it
 * is new and otherwise left out.
 */
export function noticePoller(requests: Requests, source: NoticeSource, tokens: () => Universe): Poller {
  const get = documents(requests, source.name, source.accept);
  return {
    name: source.name,
    interval: source.interval,
    async poll(context) {
      const state = context.state as NoticesState;
      const notices = source.parse(await get(source.url));
      const first = context.baseline || !state.seen;
      const seen = new Set(state.seen ?? []);
      const universe = tokens();
      const found: Found[] = [];
      for (const notice of notices) {
        const fresh = !first && !seen.has(notice.id);
        for (const matched of matchNotice(universe, notice)) {
          if (!fresh && matched.match === "symbol") continue;
          found.push({
            kind: "venue.announced",
            token: matched.token,
            source: source.venue,
            ref: notice.url,
            at: notice.at !== undefined ? iso(notice.at) : null,
            detail: {
              title: label(notice.title, 200),
              match: matched.match,
              ...(matched.match === "symbol" ? { unconfirmed: true, candidates: matched.candidates } : {}),
              ...(matched.venueName ? { venueName: matched.venueName } : {}),
            },
            ...(fresh ? {} : { baseline: true as const }),
          });
        }
      }
      await context.record(found);
      for (const { id } of notices) seen.delete(id);
      state.seen = [...seen, ...notices.map(({ id }) => id)].slice(-KEEP_SEEN);
    },
  };
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {});
const text = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const ms = (value: unknown) => {
  const n = Number(text(value));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};
const listed = (value: unknown, venue: string) => {
  if (!Array.isArray(value)) throw new Error(`${venue} did not answer with its announcements.`);
  return value.map(record);
};
const ENTITIES: Record<string, string> = { "&amp;": "&", "&#038;": "&", "&#8217;": "’", "&#8216;": "‘", "&#8211;": "–", "&#8220;": "“", "&#8221;": "”", "&#039;": "'", "&#39;": "'", "&#x27;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&nbsp;": " " };
const unescape = (value: string) => value.replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? " ");
const plain = (html: string) => unescape(html.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const tag = (item: string, name: string) => new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(item)?.[1] ?? "";
const otherMarket = (title: string) => OTHER_MARKETS.test(title);

/** Bitget's coin-listing announcements, but those about copy trading, which add no market. */
export const BITGET_NOTICES: NoticeSource = {
  name: "bitget-notices",
  venue: "Bitget",
  interval: 60_000,
  url: "https://api.bitget.com/api/v2/public/annoucements?language=en_US&annType=coin_listings",
  parse(body) {
    const answer = record(JSON.parse(body));
    if (answer.code !== "00000") throw new Error("Bitget did not answer with its announcements.");
    return listed(answer.data, "Bitget").flatMap((item) => {
      const title = text(item.annTitle);
      if (!title || item.annSubType === "copy_trading" || otherMarket(title)) return [];
      return [{ id: text(item.annId) || text(item.annUrl), title, url: text(item.annUrl), ...(ms(item.cTime) ? { at: ms(item.cTime)! } : {}), named: namedIn(title) }];
    });
  },
};

/**
 * Kraken's blog posts filed under Asset Listings, from the category feed the blog links. A post's title gives the symbol,
 * as in "BFI is available for trading!", and its text the name beside it, as in "BitFi (BFI)".
 */
export const KRAKEN_BLOG: NoticeSource = {
  name: "kraken-blog",
  venue: "Kraken",
  interval: 5 * 60_000,
  url: "https://blog.kraken.com/category/product/asset-listings/feed",
  accept: "application/rss+xml",
  parse(body) {
    if (!body.includes("<rss")) throw new Error("Kraken's blog did not answer with its feed.");
    return [...body.matchAll(/<item>([\s\S]*?)<\/item>/g)].flatMap(([, item]) => {
      const title = plain(tag(item!, "title"));
      const link = plain(tag(item!, "link"));
      if (!title || !link || otherMarket(title)) return [];
      const content = plain(tag(item!, "content:encoded") || tag(item!, "description"));
      const lead = /^([A-Z0-9]{2,15}) is (?:now )?available/.exec(title)?.[1];
      const named = merged([...(lead ? [{ symbol: lead }] : []), ...namedIn(title), ...namedIn(content, { pairs: false })]);
      const at = Date.parse(plain(tag(item!, "pubDate")));
      const contracts = [...new Set(content.match(/\b0x[0-9a-fA-F]{40}\b/g) ?? [])];
      return [{ id: plain(tag(item!, "guid")) || link, title, url: link, ...(Number.isFinite(at) ? { at } : {}), named, ...(contracts.length ? { contracts } : {}) }];
    });
  },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ZONES: Record<string, number> = { PST: -8, PDT: -7, UTC: 0, GMT: 0 };

/**
 * The earliest update an incident's text dates, as "Nov 12 , 12:09 PST": the page writes no year, so it is the year of
 * `published`, or the one before for a month after it.
 */
export function firstUpdate(text: string, published: number): number | undefined {
  const year = new Date(published).getUTCFullYear();
  const month = new Date(published).getUTCMonth();
  let first: number | undefined;
  for (const [, name, day, hour, minute, zone] of text.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) ?, (\d{1,2}):(\d{2}) (PST|PDT|UTC|GMT)\b/g)) {
    const m = MONTHS.indexOf(name!);
    const at = Date.UTC(m > month ? year - 1 : year, m, Number(day), Number(hour) - ZONES[zone!]!, Number(minute));
    if (first === undefined || at < first) first = at;
  }
  return first;
}

/**
 * Coinbase Exchange's status feed, the Atom feed its status page links: each new pair gets an incident titled "PEARL-USD
 * Markets Open", whose first update says when spot trading in the asset goes live and names it, as in "Spot trading for
 * Pearl (PEARL)", gives its contract for an asset on Robinhood Chain, and whose later updates follow the pair from its
 * auction to full trading. Dated by that first update.
 */
export const COINBASE_STATUS: NoticeSource = {
  name: "coinbase-status",
  venue: "Coinbase",
  interval: 2 * 60_000,
  url: "https://status.exchange.coinbase.com/history.atom",
  accept: "application/atom+xml",
  parse(body) {
    if (!body.includes("<feed")) throw new Error("Coinbase's status page did not answer with its feed.");
    return [...body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].flatMap(([, entry]) => {
      const title = plain(tag(entry!, "title"));
      const base = /^([A-Z0-9]{1,15})-[A-Z0-9]{2,6} Markets Open$/.exec(title)?.[1];
      const link = /<link[^>]*href="([^"]+)"/.exec(entry!)?.[1];
      if (!base || !link) return [];
      const content = plain(plain(tag(entry!, "content")));
      const published = Date.parse(plain(tag(entry!, "published")));
      const at = Number.isFinite(published) ? (firstUpdate(content, published) ?? published) : undefined;
      const onChain = [...content.matchAll(/Robinhood (?:network|chain) contract address for ([^()]{1,60}?) \(([A-Z0-9]{1,15})\) is (0x[0-9a-fA-F]{40})/gi)].map(([, name, symbol, contract]) => ({ symbol: symbol!, name: name!.trim(), contract: contract! }));
      return [{ id: plain(tag(entry!, "id")) || link, title, url: unescape(link), ...(at !== undefined ? { at } : {}), named: merged([{ symbol: base }, ...namedIn(content, { pairs: false })]), ...(onChain.length ? { onChain } : {}) }];
    });
  },
};

/**
 * Bithumb's notices, from its documented notices endpoint: those filed under 마켓 추가, market added, as in "키네틱(KNTQ)
 * 원화 마켓 추가". The name beside the symbol is Korean, which no list here gives a token, so a notice names its token
 * by the symbol alone. Bithumb writes its times in Korean time.
 */
export const BITHUMB_NOTICES: NoticeSource = {
  name: "bithumb-notices",
  venue: "Bithumb",
  interval: 60_000,
  url: "https://api.bithumb.com/v1/notices?count=20",
  parse(body) {
    return listed(JSON.parse(body), "Bithumb").flatMap((item) => {
      const title = text(item.title);
      if (!Array.isArray(item.categories) || !item.categories.includes("마켓 추가") || !title) return [];
      const at = Date.parse(`${text(item.published_at).replace(" ", "T")}+09:00`);
      return [{ id: text(item.pc_url), title, url: text(item.pc_url), ...(Number.isFinite(at) ? { at } : {}), named: merged([...title.matchAll(/\(([A-Z0-9]{1,15})\)/g)].map(([, symbol]) => ({ symbol: symbol! }))) }];
    });
  },
};

export const NOTICE_SOURCES = [COINBASE_STATUS, KRAKEN_BLOG, BITHUMB_NOTICES, BITGET_NOTICES] as const;
