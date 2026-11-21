import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { IndexedCall } from "./calls.js";
import { DEFAULT_LIMIT, knownKind, MAX_FILTERS, MAX_LIMIT } from "./watch/events.js";

export const CHANGES_NAME = "brainchain_changes";
export const WATCH_NAME = "brainchain_watch";
export const UNWATCH_NAME = "brainchain_unwatch";
/** BrainChain's own watcher, which the tools read unless BRAINCHAIN_WATCH_URL names another. */
export const HOSTED_WATCH_URL = "https://watch.usebrainchain.com";

const REQUEST_MS = 10_000;

export const WATCH_STEPS =
  "To run your own, start `npx -y brainchain-mcp watch --serve 8787` on a machine that stays on and set BRAINCHAIN_WATCH_URL to http://127.0.0.1:8787 in this server's environment.";

export const CHANGES_TOOL: Tool = {
  name: CHANGES_NAME,
  title: "New public changes about Robinhood Chain tokens",
  description:
    "New public changes about Robinhood Chain tokens since your last call, from a watcher that reads public sources on a schedule, from every 15 seconds for the chain and every minute for most exchanges to every 30 minutes for CoinGecko, and keeps each change it sees as an event. " +
    "The kinds: `pool.created`, a new Uniswap pool for a token that already has a public trace, paired with ETH, WETH, USDG or another such token; " +
    "`maker.approval` and `maker.receipt`, the first approval or first receipt of a token by a wallet brainchain_market_maker_holdings follows; " +
    "`maker.pool_queued`, a market maker adding one of a token's pools to its trading contracts' approved list for the first time: Wintermute's multisig queues each pool on its role registry, and the pool can be traded once the role takes effect, hours or days later; " +
    "`bitgo.pr_opened`, `bitgo.merged` and `bitgo.released`, a pull request opened in BitGo's public code that adds a Robinhood Chain token, its merge into master, and the first release of BitGo's @bitgo/statics package that includes the token; " +
    "`trustwallet.pr_opened`, `trustwallet.merged`, `metamask.pr_opened` and `metamask.merged`, the same for Trust Wallet's and MetaMask's token lists; " +
    "`robinhood.pair_added` and `robinhood.tradability_changed`, a symbol entering the pair list Robinhood serves to API clients, with `pairsRead`, the number of pairs read, and its tradability changing there; that list leaves out most price-only pairs, so a symbol can have had a price on Robinhood before it enters the list. `robinhood.page_added` is a page in Robinhood's crypto sitemap, which has the price-only pairs too; " +
    "`kucoin.listed`, `gate.listed`, `lifi.listed` and `coingecko.listed`, a token's contract appearing on those lists; " +
    "`venue.listed`, an exchange adding its first spot or perpetual market for a token, read from the market lists Binance Futures, Upbit, Bithumb and Bitget publish, with the market, its `status` (pre-trading, auction, trading or halted) and the time the exchange gives it, where it gives one; `venue.status_changed`, that market's status changing, such as from its opening auction to trading; " +
    "and `venue.announced`, an exchange's announcement naming a token: Kraken's Asset Listings posts, Bithumb's market-added notices and Bitget's coin-listing announcements. " +
    "An exchange's entry is tied to a token by the contract the exchange gives, or else by its own name for the asset, and `detail.match` says which; one with neither rests on the symbol alone and is marked `unconfirmed`. " +
    "Each event has `id`; `kind`; `token`, with `address`, `symbol` and `name`, any of which can be null, since Robinhood names a token by symbol only; `source`; `ref`, a link, transaction or commit to check it by; " +
    "`at`, when the source dates the change, or null for a source that publishes no date; `observedAt`, when the watcher saw it; `detail`; and `context`. " +
    "`context.worth` is the token's market cap, price and deepest pool's depth within 2% of its price (`depth2pctUsd`) when the event went out, or null with `worthMissing` saying why; `context.priorTraces` lists the token's dated public steps before the event, as brainchain_token_timeline reads them, and `context.priorEvents` what the watcher had already recorded for the token. " +
    "`context.counts` says how often earlier tokens with the step the event records were listed within 7, 30 and 90 days, from the newest BrainChain MCP dataset, as brainchain_trace_outcomes counts them: what happened to earlier tokens, which says nothing of this one. " +
    "An event goes out at most 10 seconds after the watcher sees it, with the context ready by then: `context.pending` names what is still being read, and the event is filled in once it is, so read it again by its `id` to see the rest. " +
    "For a token named only by symbol, `context.matches` lists the Robinhood Chain tokens the watcher knows by that symbol: two tokens can share one, so compare names before reading it as the same token. " +
    "Pass the `next` of your previous answer as `since` to get only what is new; `since` also takes a time in ISO 8601, for what the watcher saw from then on. Without `since` you get the newest events. " +
    "`kinds` keeps some kinds, or every kind from one source, such as `bitgo`; `tokens` keeps some tokens, by contract address, symbol or BitGo id; `limit` caps the answer at 1 to 1,000 events, 100 by default, and `more` says whether more matched. " +
    "An event says what became public and when. It does not say why, and most tokens with these traces are never listed. " +
    `The changes come from BrainChain's watcher at ${HOSTED_WATCH_URL}, or from your own \`brainchain-mcp watch --serve\` when BRAINCHAIN_WATCH_URL names it. What was already public when the watcher first started is its baseline, which it never reports as new. ` +
    "To have changes sent to you as they happen, use brainchain_watch. " +
    "Free, no key and no payment. Not advice.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      since: { type: ["string", "integer"], description: "Optional: the `next` of an earlier answer, for the events after it, or a time in ISO 8601 such as 2026-11-19T00:00:00Z." },
      kinds: { type: "array", items: { type: "string" }, maxItems: MAX_FILTERS, description: "Optional: kinds to keep, such as bitgo.pr_opened, or a source's prefix, such as bitgo." },
      tokens: { type: "array", items: { type: "string" }, maxItems: MAX_FILTERS, description: "Optional: tokens to keep, by contract address, symbol or BitGo id." },
      limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Optional: at most this many events, from 1 to ${MAX_LIMIT}. ${DEFAULT_LIMIT} by default.` },
    },
    additionalProperties: false,
  },
};

export interface ChangesQuery {
  since?: string;
  kinds?: string[];
  tokens?: string[];
  limit?: number;
}

/** BRAINCHAIN_WATCH_URL, checked, or BrainChain's own watcher when it is unset. */
export function watchUrl(value: string | undefined): URL {
  const given = value?.trim();
  if (!given) return new URL(HOSTED_WATCH_URL);
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new Error("BRAINCHAIN_WATCH_URL must be the address of a running `brainchain-mcp watch --serve`, such as http://127.0.0.1:8787.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("BRAINCHAIN_WATCH_URL must start with http:// or https://.");
  if (url.username || url.password) throw new Error("BRAINCHAIN_WATCH_URL must not hold a user name or password.");
  return url;
}

/** The tool's input, checked; throws what is wrong. */
export function changesQuery(input: Record<string, unknown>): ChangesQuery {
  const query: ChangesQuery = {};
  const { since, kinds, tokens, limit } = input;
  if (since !== undefined) {
    if (typeof since === "number" && Number.isSafeInteger(since) && since >= 0) query.since = String(since);
    else if (typeof since === "string" && since.trim()) query.since = since.trim();
    else throw new Error("since must be the next of an earlier answer, or a time in ISO 8601.");
  }
  for (const [name, value] of [["kinds", kinds], ["tokens", tokens]] as const) {
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 80)) throw new Error(`${name} must be a list of strings.`);
    if (value.length > MAX_FILTERS) throw new Error(`${name} can name at most ${MAX_FILTERS}.`);
    query[name] = value.map((item: string) => item.trim());
  }
  const unknown = (query.kinds ?? []).filter((kind) => !knownKind(kind));
  if (unknown.length) throw new Error(`Unknown kind${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. The kinds are listed in this tool's description.`);
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be a whole number from 1 to ${MAX_LIMIT}.`);
    query.limit = limit;
  }
  return query;
}

const at = (watcher: URL, path: string) => new URL(path, watcher.href.endsWith("/") ? watcher : `${watcher.href}/`);
const unreachable = (watcher: URL) => new Error(`The watcher at ${watcher.origin} could not be reached just now. Try again in a minute. ${WATCH_STEPS}`);

/** A watcher's JSON answer, with its own words for a request it refused, which are written for the caller. */
async function ask(watcher: URL, path: string, init: RequestInit, fetchImpl: typeof fetch): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
  let response: Response;
  try {
    response = await fetchImpl(at(watcher, path), { ...init, redirect: "error", headers: { Accept: "application/json", "User-Agent": "brainchain-mcp", ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(REQUEST_MS) });
  } catch {
    throw unreachable(watcher);
  }
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (response.status >= 400 && response.status < 500 && response.status !== 404 && typeof body?.error === "string") throw new Error(body.error.slice(0, 300));
  return { status: response.status, body };
}

/** The events a watcher has for the query. */
export async function readChanges(watcher: URL, query: ChangesQuery, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const params = new URLSearchParams();
  if (query.since !== undefined) params.set("since", query.since);
  if (query.kinds?.length) params.set("kinds", query.kinds.join(","));
  if (query.tokens?.length) params.set("tokens", query.tokens.join(","));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const { status, body } = await ask(watcher, `events${params.size ? `?${params}` : ""}`, {}, fetchImpl);
  if (status !== 200 || !body || !Array.isArray(body.events) || typeof body.next !== "number") {
    throw new Error(`The watcher at ${watcher.origin} answered ${status} without a list of events. Check that BRAINCHAIN_WATCH_URL names a running \`brainchain-mcp watch --serve\`.`);
  }
  return { watcher: watcher.origin, readAt: body.readAt, events: body.events, next: body.next, more: body.more === true };
}

/** A wallet's calls as a watcher read them from BrainChain's DecisionLog, oldest first. */
export async function readCalls(watcher: URL, caller: string, fetchImpl: typeof fetch = fetch): Promise<IndexedCall[]> {
  const { status, body } = await ask(watcher, `calls?caller=${encodeURIComponent(caller)}`, {}, fetchImpl);
  if (status !== 200 || !body || !Array.isArray(body.calls)) throw new Error(`The watcher at ${watcher.origin} answered ${status} without a list of calls. Check that BRAINCHAIN_WATCH_URL names a watcher on brainchain-mcp 0.18.0 or later.`);
  return body.calls as IndexedCall[];
}

export interface WatchRequest {
  url: string;
  kinds?: string[];
  tokens?: string[];
}

/** Makes a watch on the watcher; the answer holds its secret and manage token, which the watcher never gives out again. */
export async function createWatch(watcher: URL, request: WatchRequest, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const { status, body } = await ask(watcher, "watches", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) }, fetchImpl);
  if (status !== 201 || typeof body?.id !== "string") throw new Error(`The watcher at ${watcher.origin} answered ${status} and made no watch. Try again in a minute.`);
  return { watcher: watcher.origin, ...body };
}

export async function removeWatch(watcher: URL, id: string, manageToken: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const { status } = await ask(watcher, `watches/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${manageToken}` } }, fetchImpl);
  if (status === 204) return { removed: true, id };
  if (status === 404) throw new Error("No watch has that id and manage token on this watcher. It may be removed already.");
  throw new Error(`The watcher at ${watcher.origin} answered ${status}. Try again in a minute.`);
}

/**
 * Follows a watcher's stream and calls `seen` with each event's id, from the newest on, until `signal` aborts. A stream
 * that drops is opened again after a wait that grows to a minute, from the last id seen.
 */
export async function followChanges(watcher: URL, seen: (id: number) => void, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<void> {
  let last: number | undefined;
  for (let wait = 1_000; !signal.aborted; wait = Math.min(wait * 2, 60_000)) {
    try {
      const response = await fetchImpl(at(watcher, "events/stream"), { redirect: "error", signal, headers: { Accept: "text/event-stream", "User-Agent": "brainchain-mcp", ...(last ? { "Last-Event-ID": String(last) } : {}) } });
      if (response.status !== 200 || !response.body) throw new Error();
      wait = 1_000;
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const id = /^id: (\d+)$/m.exec(buffer.slice(0, end))?.[1];
          buffer = buffer.slice(end + 2);
          if (id) seen((last = Number(id)));
        }
        if (buffer.length > 1_000_000) buffer = "";
      }
    } catch {
      // A dropped or refused stream is opened again below.
    }
    if (signal.aborted) return;
    await new Promise((resolve) => setTimeout(resolve, wait).unref());
  }
}

/** An id and manage token as brainchain_watch gave them, checked. */
export function unwatchArgs(input: Record<string, unknown>): { id: string; manageToken: string } {
  const { id, manageToken } = input;
  if (typeof id !== "string" || !/^[\w-]{22}$/.test(id)) throw new Error("id must be the id brainchain_watch gave: 22 letters, digits, - or _.");
  if (typeof manageToken !== "string" || !/^[\w-]{43}$/.test(manageToken)) throw new Error("manageToken must be the manage token brainchain_watch gave: 43 letters, digits, - or _.");
  return { id, manageToken };
}

/** A new watch's request, checked before it is sent. */
export function watchArgsOf(input: Record<string, unknown>): WatchRequest {
  if (typeof input.url !== "string" || !input.url.trim()) throw new Error("url is required: the https address to send changes to.");
  const url = input.url.trim();
  if (url.length > 2048 || !/^https:\/\//i.test(url)) throw new Error("url must be an https address of at most 2,048 characters.");
  const { kinds, tokens } = changesQuery({ kinds: input.kinds, tokens: input.tokens });
  return { url, ...(kinds ? { kinds } : {}), ...(tokens ? { tokens } : {}) };
}

const FILTERS = {
  kinds: { type: "array", items: { type: "string" }, maxItems: MAX_FILTERS, description: "Optional: kinds to keep, such as bitgo.pr_opened, or a source's prefix, such as bitgo." },
  tokens: { type: "array", items: { type: "string" }, maxItems: MAX_FILTERS, description: "Optional: tokens to keep, by contract address, symbol or BitGo id." },
} as const;

export const WATCH_TOOL: Tool = {
  name: WATCH_NAME,
  title: "Have new public changes about Robinhood Chain tokens sent to you",
  description:
    "Has each new public change about a Robinhood Chain token sent to an https address as the watcher sees it, so an agent or its user hears without asking. " +
    "`url` can be a Discord or Slack incoming webhook, or a Telegram bot's sendMessage URL with ?chat_id=, which get one line per change: what changed, the token, what it is worth now and the link to check it, and a second short line with the worth when it was read after the change went out. Changes that come up within 5 seconds of each other arrive as one message, a line each. " +
    "Any other https endpoint gets each event as JSON, the same as brainchain_changes returns it, and later a `{type: \"update\", id, context}` with the finished context when the event went out unfinished, each signed: X-BrainChain-Signature is v1= and the hex HMAC-SHA256, keyed with `secret`, of X-BrainChain-Timestamp, a full stop and the body. Refuse a delivery whose timestamp is more than 300 seconds off. " +
    "`kinds` and `tokens` keep only some changes, as in brainchain_changes. Only changes after the watch is made are sent, in order, each once. " +
    "The answer has `id`, `secret` and `manageToken`. Keep all three private: the watcher shows `manageToken` only this once, and it removes the watch with brainchain_unwatch. The watcher keeps the URL to send to and never shows it again. " +
    "An endpoint that fails is tried again for about two hours, then the watch is switched off; an endpoint that asks the watcher to wait (429) is waited for, which does not count as failing. The url must be https, on port 443, at a public address. One address can hold 5 watches and make 10 an hour. " +
    `The watch is made on BrainChain's watcher at ${HOSTED_WATCH_URL}, or on the one BRAINCHAIN_WATCH_URL names. Free, no key and no payment.`,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", maxLength: 2048, description: "The https address to send changes to: a Discord or Slack webhook, a Telegram bot's sendMessage URL with ?chat_id=, or your own endpoint." }, ...FILTERS },
    required: ["url"],
    additionalProperties: false,
  },
};

export const UNWATCH_TOOL: Tool = {
  name: UNWATCH_NAME,
  title: "Stop changes being sent",
  description: "Removes a watch made with brainchain_watch, so nothing more is sent to its address. Pass its `id` and the `manageToken` brainchain_watch gave. A wrong token and an unknown id get the same answer. Free, no key and no payment.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", pattern: "^[\\w-]{22}$", description: "The watch's id, from brainchain_watch." },
      manageToken: { type: "string", pattern: "^[\\w-]{43}$", description: "The manage token brainchain_watch gave with it." },
    },
    required: ["id", "manageToken"],
    additionalProperties: false,
  },
};

/** The resource a client can subscribe to, to hear of each new change while this server runs. */
export const CHANGES_URI = "brainchain://changes";
export const CHANGES_RESOURCE = {
  uri: CHANGES_URI,
  name: "changes",
  title: "New public changes about Robinhood Chain tokens",
  description: "The newest public changes about Robinhood Chain tokens, as brainchain_changes returns them. Subscribe to hear of each new one: the server follows the watcher's stream while it runs, and sends resources/updated for each change.",
  mimeType: "application/json",
};
