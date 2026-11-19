import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Address } from "viem";

import { BY_SYMBOL, TOKEN_INPUT, within } from "./custody.js";
import { gitHubAuth } from "./github.js";
import { blockOf, inTurn, label, type Moment } from "./history.js";

export const SIGHTINGS_NAME = "brainchain_token_sightings";

/** How long a document that was read is kept. The lists are megabytes and change a few times a day. */
export const KEEP_MS = 10 * 60_000;
/** How many documents are kept. Seven are lists every answer reads; the rest are single tokens' files and their commit feeds. */
export const MAX_KEPT = 200;
/** A token's file and then its commit feed are read one after the other, and both have to fit in an answer. */
const REQUEST_MS = 12_000;
const ANSWER_MS = 40_000;
/** A commit feed shows a file's last twenty commits, so a full feed may not reach back to the first. */
const FEED_ENTRIES = 20;
const CHAIN_ID = 4663;

const TRUST_WALLET = "trustwallet/assets";
const METAMASK = "MetaMask/contract-metadata";

export const SIGHTINGS_TOOL: Tool = {
  name: SIGHTINGS_NAME,
  title: "Where a Robinhood Chain token is already listed",
  description:
    "Which public wallet lists and exchanges already carry a Robinhood Chain token, and what Robinhood's own public pages show for its symbol, read from each source without a key. " +
    "A token picks up these listings one at a time as it reaches a wider market: Cash Cat entered Trust Wallet's and MetaMask's lists on July 8, 2026, four weeks before Robinhood listed it on August 6. " +
    "On its own a sighting says little: most tokens on these lists are never listed by Robinhood. " +
    "Pass the token's contract address as `token`; the `contract` of an entry from brainchain_custody_additions works. " +
    BY_SYMBOL +
    "`lists` has an entry for Trust Wallet, MetaMask, LI.FI and CoinGecko, each with its `source` and `listed`. " +
    "Trust Wallet and MetaMask keep one file for each token in their public code. When the token is listed, their entries add `link`, a link to that file, and `since`, when the list's master branch took the file: the time the pull request that added it was merged, which can be days after its commit was made. " +
    "`since` is left out when that time cannot be shown: the file reached master without a pull request, it has more commits than GitHub's feed of them shows, or GitHub could not be read just now. " +
    "Each `since` takes one of the 60 requests an hour GitHub allows one IP address without a key, or of the allowance of the GITHUB_TOKEN the operator set, and is kept while the server runs. " +
    "Trust Wallet also keeps a file for a token it warns about or has dropped: its entry then has `listed` false and a `status` of `spam` or `abandoned`. " +
    "`exchanges` has an entry for KuCoin and Gate, each with its `source`, `listed` and, when listed, whether `deposits` and `withdrawals` are open. " +
    "All six are matched by the token's contract address. The tool reads the chain only for the time of `atBlock`, so an address that is not a token is listed nowhere. " +
    "Robinhood and Bitstamp, which Robinhood owns, publish no contract addresses, so they are matched by symbol: `robinhood` has an entry for each `symbol` of letters and digits that the six sources give the token. " +
    "`page` says whether Robinhood's public site has a page for that symbol, `pair` whether Robinhood's public list of crypto pairs has it, and `bitstamp` whether Bitstamp lists it on Robinhood Chain. " +
    "For a symbol with a pair, `name` is Robinhood's own name for the asset and `tradable` says whether customers can trade it or only see its price. " +
    "Two tokens can share a symbol, so compare that `name` with the token's own before reading an entry as this token: a token on Robinhood Chain that calls itself DOGE is not Dogecoin. " +
    "An entry with a `page` and no `pair` has no name to compare, so it says only that Robinhood has a page under that symbol. " +
    "`unread` names any source that could not be read just now: Trust Wallet, MetaMask, LI.FI, CoinGecko, KuCoin, Gate, Robinhood's site, Robinhood's pairs or Bitstamp. " +
    "A list or exchange that could not be read has no entry, and a `robinhood` entry leaves out `page`, `pair` or `bitstamp` when its source could not be read. Neither is reported as unlisted. " +
    "`token` holds the `contract` and the `symbol` and `name` the six sources give the token. `readAt` is when the answer was made. A list that was read is kept for ten minutes while the server runs, so what an entry says can be that old. " +
    "To see only what was public at a point in the past, pass `atBlock`, a block number, or `at`, a time in ISO 8601 such as 2026-08-06T00:00:00Z; `until` then gives the time used (`at`), and the `block` for `atBlock`. " +
    "A Trust Wallet or MetaMask entry stays when its `since` is at or before that time. The other sources publish no date for a listing, and a list's file can lack one, so a token listed there now may or may not have been listed then: " +
    "`withheld` names each such source, with the `symbol` for Robinhood's site, Robinhood's pairs and Bitstamp, and the `link` or `status` of a list's file, and `lists`, `exchanges` and `robinhood` leave them out. A source that does not list the token now says nothing about then, so it has no entry. " +
    "The first answer takes a few seconds, and later ones within those ten minutes come at once. " +
    "Free, no key and no payment. Not advice.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      token: TOKEN_INPUT,
      atBlock: { type: "integer", minimum: 0, description: "Optional: a block number. Only the sightings public by the end of that block are listed." },
      at: { type: "string", description: "Optional, in place of atBlock: a time in ISO 8601, such as 2026-08-06T00:00:00Z. Only the sightings public by then are listed." },
    },
    required: ["token"],
    additionalProperties: false,
  },
};

export interface ListSighting {
  source: "Trust Wallet" | "MetaMask" | "LI.FI" | "CoinGecko";
  listed: boolean;
  /** When the list's master branch took the token's file: the merge of the pull request that added it. */
  since?: string;
  link?: string;
  /** How Trust Wallet marks a token it keeps a file for and does not list. */
  status?: "spam" | "abandoned";
}

export interface ExchangeSighting {
  source: "KuCoin" | "Gate";
  listed: boolean;
  deposits?: boolean;
  withdrawals?: boolean;
}

/** What Robinhood shows for one symbol. A field is left out when its source could not be read. */
export interface RobinhoodSighting {
  symbol: string;
  page?: boolean;
  pair?: boolean;
  /** Robinhood's own name for the asset, which tells two tokens with one symbol apart. */
  name?: string;
  tradable?: boolean;
  bitstamp?: boolean;
}

/** A sighting public now whose first public time cannot be shown, so a cut-off can place it on neither side. */
export interface WithheldSighting {
  source: string;
  symbol?: string;
  name?: string;
  link?: string;
  status?: "spam" | "abandoned";
}

export interface SightingsBoard {
  chain: "Robinhood Chain";
  token: { contract: Address; symbol?: string; name?: string };
  readAt: string;
  /** With a cut-off: the time the sightings were cut at, and the block it was given as. */
  until?: { block?: number; at: string };
  lists: ListSighting[];
  exchanges: ExchangeSighting[];
  robinhood: RobinhoodSighting[];
  withheld?: WithheldSighting[];
  unread: string[];
}

/** As `CustodyError`: a message already written for the person asking. */
export class SightingsError extends Error {}

/** A document as a source served it. The reader passes on a missing one and fails on any other status. */
export interface Page {
  status: 200 | 404;
  body: string;
}

/** A document and the one function that reads it, and how long what it makes is kept when not `KEEP_MS`. */
export interface Source<T> {
  url: string;
  parse(page: Page): T;
  keep?: number;
}

export interface SightingsReader {
  /** What a source's `parse` makes of its document, kept for its `keep` or `KEEP_MS`. A read or a parse that failed is not kept. */
  get<T>(source: Source<T>): Promise<T>;
}

/** What a source calls one token. */
interface Named {
  symbol: string;
  name: string;
}

interface Listing extends Named {
  deposits: boolean;
  withdrawals: boolean;
}

interface Filed extends Named {
  since?: string;
  link: string;
}

/** A token a list keeps a file for and does not list, and what the file says of it. */
interface Marked {
  status: string;
}

const isNamed = (found: object): found is Named => "symbol" in found;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {});
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * The array a source serves its list as. A source that is busy or blocking answers 200 with something else, an error in
 * JSON or a page of HTML, and that has to count as unread, never as a list the token is missing from.
 */
function listIn(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("The source did not answer with its list.");
  return value;
}

/** A parser for a document that must be there: a 404 is a failure, not an answer. */
const required = <T>(parse: (body: string) => T) => ({ status, body }: Page): T => {
  if (status !== 200) throw new Error("The source has no such document.");
  return parse(body);
};

/** What a list of tokens in the Uniswap shape calls each of this chain's, by lowercased address. */
const tokensByContract = (tokens: unknown[]): Map<string, Named> =>
  new Map(
    tokens
      .map(record)
      .filter(({ chainId }) => chainId === CHAIN_ID)
      .map(({ address, symbol, name }) => [text(address).toLowerCase(), { symbol: text(symbol), name: text(name) }]),
  );

/** LI.FI's API files the tokens it routes under each chain's id. */
const lifiTokens = (body: string) => tokensByContract(listIn(record(record(JSON.parse(body)).tokens)[CHAIN_ID]));
/** CoinGecko's list for the chain holds its tokens under `tokens`. */
const coingeckoTokens = (body: string) => tokensByContract(listIn(record(JSON.parse(body)).tokens));

/** KuCoin's currencies that have a contract on Robinhood Chain, by lowercased address. */
function kucoinList(body: string): Map<string, Listing> {
  const byContract = new Map<string, Listing>();
  for (const currency of listIn(record(JSON.parse(body)).data).map(record)) {
    for (const { chainId, contractAddress, isDepositEnabled, isWithdrawEnabled } of array(currency.chains).map(record)) {
      if (chainId !== "robinhood" || !text(contractAddress)) continue;
      byContract.set(text(contractAddress).toLowerCase(), { symbol: text(currency.currency), name: text(currency.fullName), deposits: isDepositEnabled === true, withdrawals: isWithdrawEnabled === true });
    }
  }
  return byContract;
}

/** Gate's currencies that have a contract on Robinhood Chain, by lowercased address. Gate keeps the ones it delisted in the same list. */
function gateList(body: string): Map<string, Listing> {
  const byContract = new Map<string, Listing>();
  for (const currency of listIn(JSON.parse(body)).map(record)) {
    if (currency.delisted === true) continue;
    for (const { name, addr, deposit_disabled, withdraw_disabled } of array(currency.chains).map(record)) {
      if (name !== "ROBINHOOD" || !text(addr)) continue;
      byContract.set(text(addr).toLowerCase(), { symbol: text(currency.currency), name: text(currency.name), deposits: deposit_disabled === false, withdrawals: withdraw_disabled === false });
    }
  }
  return byContract;
}

/** The symbols Bitstamp lists on Robinhood Chain, which it calls hoodeth. */
function bitstampSymbols(body: string): Set<string> {
  return new Set(
    listIn(JSON.parse(body))
      .map(record)
      .filter(({ networks }) => array(networks).some((network) => record(network).network === "hoodeth"))
      .map(({ currency }) => text(currency).toUpperCase()),
  );
}

/** The symbols Robinhood's public site has a crypto page for. */
function robinhoodPages(body: string): Set<string> {
  if (!body.includes("<urlset")) throw new Error("Robinhood did not answer with its sitemap.");
  return new Set([...body.matchAll(/\/us\/en\/crypto\/([A-Za-z0-9]{1,15})\/?</g)].map((page) => page[1]!.toUpperCase()));
}

/** Robinhood's crypto pairs by the asset's symbol: its name for the asset, and whether customers can trade it. */
function robinhoodPairs(body: string): Map<string, { name?: string; tradable: boolean }> {
  const { next, results } = record(JSON.parse(body));
  // The list fits one page today. Read as whole once it does not, it would report every pair on a later page as missing.
  if (next !== null && next !== undefined) throw new Error("Robinhood's pair list no longer fits one page.");
  return new Map(
    listIn(results)
      .map(record)
      .map(({ asset_currency, tradability }) => {
        const name = label(text(record(asset_currency).name), 60);
        return [text(record(asset_currency).code).toUpperCase(), { ...(name ? { name } : {}), tradable: tradability === "tradable" }];
      }),
  );
}

/**
 * The oldest commit in a file's commit feed; nothing when the feed is empty, or full and so may not reach the first commit,
 * or when that entry names no commit.
 */
function firstCommit(feed: string): string | undefined {
  const entries = [...feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => ({
    commit: /<id>[^<]*Commit\/([0-9a-f]{40})<\/id>/.exec(entry!)?.[1],
    at: Date.parse(/<updated>([^<]+)<\/updated>/.exec(entry!)?.[1] ?? ""),
  }));
  if (entries.length === 0 || entries.length >= FEED_ENTRIES || entries.some(({ at }) => Number.isNaN(at))) return undefined;
  return entries.reduce((oldest, entry) => (entry.at < oldest.at ? entry : oldest)).commit;
}

/**
 * When a pull request that brought a commit was merged into master, which is when master took the commit: the earliest
 * such merge, or nothing for a commit pushed without one. A commit's own date is when it was made, which can be days
 * before it was merged. GitHub's merge time is the time it recorded for the push, or a second after it.
 */
function mergedAt({ status, body }: Page): string | undefined {
  if (status === 404) return undefined;
  const merges = listIn(JSON.parse(body))
    .map(record)
    .filter(({ base, merged_at }) => record(base).ref === "master" && typeof merged_at === "string")
    .map(({ merged_at }) => Date.parse(merged_at as string))
    .filter((at) => !Number.isNaN(at));
  return merges.length > 0 ? new Date(Math.min(...merges)).toISOString() : undefined;
}

/**
 * A token's file in a list kept as one file per token; nothing when the file is not there. Both lists give every token a
 * symbol, so a document without one is some other answer and counts as unread.
 */
export function tokenFile({ status, body }: Page): Record<string, unknown> | undefined {
  if (status === 404) return undefined;
  const entry = record(JSON.parse(body));
  if (!text(entry.symbol)) throw new Error("The source did not answer with the token's file.");
  return entry;
}

// Each document has the one parser it is read with, which is what lets the reader keep the result under the document's URL.
export const LIFI = { url: `https://li.quest/v1/tokens?chains=${CHAIN_ID}`, parse: required(lifiTokens) };
export const COINGECKO = { url: "https://tokens.coingecko.com/robinhood/all.json", parse: required(coingeckoTokens) };
export const KUCOIN = { url: "https://api.kucoin.com/api/v3/currencies", parse: required(kucoinList) };
export const GATE = { url: "https://api.gateio.ws/api/v4/spot/currencies", parse: required(gateList) };
export const ROBINHOOD_PAGES = { url: "https://robinhood.com/us/en/sitemap-crypto.xml", parse: required(robinhoodPages) };
export const ROBINHOOD_PAIRS = { url: "https://nummus.robinhood.com/currency_pairs/", parse: required(robinhoodPairs) };
const BITSTAMP = { url: "https://www.bitstamp.net/api/v2/currencies/", parse: required(bitstampSymbols) };
const feedCommit = required(firstCommit);

/** A source's answer, or that it could not be read. */
type Read<T> = { value: T } | { failed: true };
const attempt = <T>(reading: Promise<T>): Promise<Read<T>> => reading.then((value) => ({ value }), () => ({ failed: true as const }));

/** When master took a file: the merge of the pull request behind its first commit. A merge never moves, so it is kept for good. */
async function filedAt(reader: SightingsReader, repo: string, path: string): Promise<string | undefined> {
  const commit = await reader.get({ url: `https://github.com/${repo}/commits/master/${path}.atom`, parse: feedCommit });
  return commit && reader.get({ url: `https://api.github.com/repos/${repo}/commits/${commit}/pulls`, parse: mergedAt, keep: Infinity });
}

/**
 * A token's entry in a list kept as one file per token in a GitHub repository, with when master took the file; nothing
 * when the file is not there, and the file's status alone when `listed` says the file does not list the token.
 */
async function fileList(reader: SightingsReader, repo: string, path: string, listed: (status: unknown) => boolean): Promise<Filed | Marked | undefined> {
  const entry = await reader.get({ url: `https://raw.githubusercontent.com/${repo}/master/${path}`, parse: tokenFile });
  if (!entry) return undefined;
  if (!listed(entry.status)) return { status: text(entry.status) };
  const dated = await attempt(filedAt(reader, repo, path));
  return { symbol: text(entry.symbol), name: text(entry.name), ...("value" in dated && dated.value ? { since: dated.value } : {}), link: `https://github.com/${repo}/blob/master/${path}` };
}

/**
 * Where `token` is listed. Every source is read for itself: one that fails goes to `unread` and takes nothing else with
 * it. Robinhood and Bitstamp know a token by its symbol only, so they are looked up under every symbol the other sources
 * give it, and Robinhood's name for each goes out with it: nothing else says whether it is the same token.
 */
export async function tokenSightings(reader: SightingsReader, token: Address, now = new Date(), until?: { at: number; block?: bigint }): Promise<SightingsBoard> {
  const contract = token.toLowerCase();
  const listing = <T>(source: Source<Map<string, T>>) => attempt(reader.get(source).then((byContract) => byContract.get(contract)));
  const [trust, metamask, lifi, coingecko, kucoin, gate, pages, pairs, bitstamp] = await Promise.all([
    // Trust Wallet keeps the file of a token it has dropped or warns about, and says which in the file's status.
    attempt(fileList(reader, TRUST_WALLET, `blockchains/robinhoodchain/assets/${token}/info.json`, (status) => status === "active")),
    attempt(fileList(reader, METAMASK, `metadata/eip155:${CHAIN_ID}/erc20:${token}.json`, () => true)),
    listing(LIFI),
    listing(COINGECKO),
    listing(KUCOIN),
    listing(GATE),
    attempt(reader.get(ROBINHOOD_PAGES)),
    attempt(reader.get(ROBINHOOD_PAIRS)),
    attempt(reader.get(BITSTAMP)),
  ]);
  const unread: string[] = [];
  const named: Named[] = [];
  /** An entry for each source that was read. One that was not is named in `unread`, and what a source that lists the token calls it goes to `named`. */
  const entries = <S extends string, T extends object, E>(reads: readonly (readonly [S, Read<T | undefined>])[], entry: (source: S, found: T | undefined) => E): E[] =>
    reads.flatMap(([source, read]) => {
      if ("failed" in read) {
        unread.push(source);
        return [];
      }
      if (read.value && isNamed(read.value)) named.push(read.value);
      return [entry(source, read.value)];
    });
  const lists = entries<ListSighting["source"], (Named & Partial<Filed>) | Marked, ListSighting>(
    [["Trust Wallet", trust], ["MetaMask", metamask], ["LI.FI", lifi], ["CoinGecko", coingecko]],
    (source, found) => {
      if (!found) return { source, listed: false };
      if ("status" in found) return { source, listed: false, ...(found.status === "spam" || found.status === "abandoned" ? { status: found.status } : {}) };
      return { source, listed: true, ...(found.since ? { since: found.since } : {}), ...(found.link ? { link: found.link } : {}) };
    },
  );
  const exchanges = entries<ExchangeSighting["source"], Listing, ExchangeSighting>(
    [["KuCoin", kucoin], ["Gate", gate]],
    (source, found) => ({ source, listed: found !== undefined, ...(found ? { deposits: found.deposits, withdrawals: found.withdrawals } : {}) }),
  );
  if (lists.length + exchanges.length === 0) throw new SightingsError("None of the lists could be read just now. Try again in a minute.");
  if ("failed" in pages) unread.push("Robinhood's site");
  if ("failed" in pairs) unread.push("Robinhood's pairs");
  if ("failed" in bitstamp) unread.push("Bitstamp");

  // The sources' own words for the token, cleaned as any outside text is.
  const given = named.map(({ symbol }) => label(symbol, 20)).filter(Boolean);
  const name = named.map((source) => label(source.name, 60)).find(Boolean);
  // Robinhood's symbols are letters and digits, so no other is looked up. The check comes before the capitals, which turn a few other letters into these.
  const symbols = [...new Set(given.filter((symbol) => /^[A-Za-z0-9]{1,15}$/.test(symbol)).map((symbol) => symbol.toUpperCase()))];
  const board: SightingsBoard = {
    chain: "Robinhood Chain",
    token: { contract: token, ...(given[0] ? { symbol: given[0] } : {}), ...(name ? { name } : {}) },
    readAt: now.toISOString(),
    lists,
    exchanges,
    robinhood: symbols.map((symbol) => ({
      symbol,
      ...("value" in pages ? { page: pages.value.has(symbol) } : {}),
      ...("value" in pairs ? { pair: pairs.value.has(symbol), ...pairs.value.get(symbol) } : {}),
      ...("value" in bitstamp ? { bitstamp: bitstamp.value.has(symbol) } : {}),
    })),
    unread,
  };
  return until ? cut(board, until) : board;
}

/**
 * The board as it stood at `until`, as far as it can be shown. A dated listing stays when master took its file by then and
 * goes when master took it later. Anything else the token has now, a listing without a date or a mark, an exchange or a
 * Robinhood symbol, was public by `readAt` and maybe long before: it stays when the cut-off is not before `readAt`, and
 * otherwise goes to `withheld`. A source that does not list the token now says nothing of then, so it has no entry.
 */
function cut(board: SightingsBoard, until: { at: number; block?: bigint }): SightingsBoard {
  const range = { until: { ...(until.block !== undefined ? { block: Number(until.block) } : {}), at: new Date(until.at).toISOString() } };
  if (Date.parse(board.readAt) <= until.at) return { ...board, ...range, withheld: [] };
  const withheld: WithheldSighting[] = [];
  const lists = board.lists.filter(({ source, listed, since, link, status }) => {
    if (listed && since) return Date.parse(since) <= until.at;
    if (listed || status) withheld.push({ source, ...(link ? { link } : {}), ...(status ? { status } : {}) });
    return false;
  });
  for (const { source, listed } of board.exchanges) if (listed) withheld.push({ source });
  for (const { symbol, page, pair, name, bitstamp } of board.robinhood) {
    if (page) withheld.push({ source: "Robinhood's site", symbol });
    if (pair) withheld.push({ source: "Robinhood's pairs", symbol, ...(name ? { name } : {}) });
    if (bitstamp) withheld.push({ source: "Bitstamp", symbol });
  }
  return { ...board, ...range, lists, exchanges: [], robinhood: [], withheld };
}

/** Reads the sources over HTTPS with no key. Of the documents it keeps, the one read longest ago goes first, so the lists every answer reads stay. */
export function sightingsReader(fetchImpl: typeof fetch = fetch, clock: () => number = Date.now): SightingsReader {
  const kept = new Map<string, { until: number; parse: unknown; value: Promise<unknown> }>();
  return {
    get<T>({ url, parse, keep }: Source<T>): Promise<T> {
      const earlier = kept.get(url);
      kept.delete(url);
      if (earlier && earlier.parse === parse && clock() < earlier.until) {
        kept.set(url, earlier);
        // Kept by this same parser, so it is what this parser returns.
        return earlier.value as Promise<T>;
      }
      if (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value!);
      const value = (async () => {
        const response = await fetchImpl(url, { headers: { Accept: "*/*", "User-Agent": "brainchain-mcp", ...gitHubAuth(url) }, signal: AbortSignal.timeout(REQUEST_MS) });
        if (response.status !== 200 && response.status !== 404) {
          await response.body?.cancel().catch(() => {});
          throw new Error(`${new URL(url).host} answered ${response.status}.`);
        }
        return parse({ status: response.status, body: await response.text() });
      })();
      const entry = { until: Infinity, parse, value };
      kept.set(url, entry);
      value.then(
        () => (entry.until = clock() + (keep ?? KEEP_MS)),
        () => {
          if (kept.get(url) === entry) kept.delete(url);
        },
      );
      return value;
    },
  };
}

let reader: SightingsReader | undefined;
const times = new Map<string, Promise<bigint>>();

/** A block is read from the chain for its time, in turn with the other tools that read it; a time needs no chain. */
export async function readTokenSightings(token: Address, moment?: Moment): Promise<SightingsBoard> {
  reader ??= sightingsReader();
  const until = moment && ("time" in moment ? { at: moment.time } : await inTurn(async (chain) => blockOf(chain, moment, await chain.getBlockNumber(), times)).then(({ block, at }) => ({ block, at: Date.parse(at) })));
  return within(ANSWER_MS, tokenSightings(reader, token, new Date(), until), new SightingsError("The lists are taking too long to read. Try again in a minute."));
}
