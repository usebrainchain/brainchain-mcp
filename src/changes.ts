import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { DEFAULT_LIMIT, knownKind, MAX_LIMIT } from "./watch/events.js";
import { MAX_FILTERS } from "./watch/serve.js";

export const CHANGES_NAME = "brainchain_changes";

const REQUEST_MS = 10_000;

export const WATCH_STEPS =
  "Run `npx -y brainchain-mcp watch --serve 8787` on a machine that stays on, set BRAINCHAIN_WATCH_URL to http://127.0.0.1:8787 in this server's environment, and restart this server. " +
  "On its first run the watcher records what is already public as its baseline; every change after that comes back here.";

export const CHANGES_TOOL: Tool = {
  name: CHANGES_NAME,
  title: "New public changes about Robinhood Chain tokens",
  description:
    "New public changes about Robinhood Chain tokens since your last call, from a watcher that reads public sources on a schedule, from every 15 seconds for the chain to every 30 minutes for CoinGecko, and keeps each change it sees as an event. " +
    "The kinds: `pool.created`, a new Uniswap pool for a token that already has a public trace, paired with ETH, WETH, USDG or another such token; " +
    "`maker.approval` and `maker.receipt`, the first approval or first receipt of a token by a wallet brainchain_market_maker_holdings follows; " +
    "`bitgo.pr_opened`, `bitgo.merged` and `bitgo.released`, a pull request opened in BitGo's public code that adds a Robinhood Chain token, its merge into master, and the first release of BitGo's @bitgo/statics package that includes the token; " +
    "`trustwallet.pr_opened`, `trustwallet.merged`, `metamask.pr_opened` and `metamask.merged`, the same for Trust Wallet's and MetaMask's token lists; " +
    "`robinhood.pair_added`, `robinhood.tradability_changed` and `robinhood.page_added`, from Robinhood's public list of crypto pairs and its crypto pages; " +
    "and `kucoin.listed`, `gate.listed`, `lifi.listed` and `coingecko.listed`, a token's contract appearing on those lists. " +
    "Each event has `id`; `kind`; `token`, with `address`, `symbol` and `name`, any of which can be null, since Robinhood names a token by symbol only; `source`; `ref`, a link, transaction or commit to check it by; " +
    "`at`, when the source dates the change, or null for a source that publishes no date; `observedAt`, when the watcher saw it; `detail`; and `context`. " +
    "`context.priorTraces` lists the token's dated public steps before the event, as brainchain_token_timeline reads them, and `context.priorEvents` what the watcher had already recorded for the token. " +
    "For a token named only by symbol, `context.matches` lists the Robinhood Chain tokens the watcher knows by that symbol: two tokens can share one, so compare names before reading it as the same token. " +
    "Pass the `next` of your previous answer as `since` to get only what is new; `since` also takes a time in ISO 8601, for what the watcher saw from then on. Without `since` you get the newest events. " +
    "`kinds` keeps some kinds, or every kind from one source, such as `bitgo`; `tokens` keeps some tokens, by contract address, symbol or BitGo id; `limit` caps the answer at 1 to 1,000 events, 100 by default, and `more` says whether more matched. " +
    "An event says what became public and when. It does not say why, and most tokens with these traces are never listed. " +
    "The watcher runs apart from this server, and BRAINCHAIN_WATCH_URL tells this server where. Without it the tool answers with how to start one. What was already public when the watcher first started is its baseline, which it never reports as new. " +
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

/** BRAINCHAIN_WATCH_URL, checked: undefined when unset, and an error for a value that is not an http or https address. */
export function watchUrl(value: string | undefined): URL | undefined {
  const given = value?.trim();
  if (!given) return undefined;
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

/** The events a running watcher has for the query, or, with no watcher set, how to start one. */
export async function readChanges(watcher: URL | undefined, query: ChangesQuery, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  if (!watcher) return { watching: false, message: `No watcher is set for this server. ${WATCH_STEPS}` };
  const url = new URL("events", watcher.href.endsWith("/") ? watcher : `${watcher.href}/`);
  if (query.since !== undefined) url.searchParams.set("since", query.since);
  if (query.kinds?.length) url.searchParams.set("kinds", query.kinds.join(","));
  if (query.tokens?.length) url.searchParams.set("tokens", query.tokens.join(","));
  if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": "brainchain-mcp" }, signal: AbortSignal.timeout(REQUEST_MS) });
  } catch {
    throw new Error(`The watcher at ${watcher.origin} could not be reached. Check that \`brainchain-mcp watch --serve\` is running there and that BRAINCHAIN_WATCH_URL names it.`);
  }
  const body = (await response.json().catch(() => undefined)) as { error?: unknown; events?: unknown; next?: unknown; more?: unknown; readAt?: unknown } | undefined;
  if (response.status === 400 && typeof body?.error === "string") throw new Error(body.error.slice(0, 300));
  if (!response.ok || !body || !Array.isArray(body.events) || typeof body.next !== "number") {
    throw new Error(`The watcher at ${watcher.origin} answered ${response.status} without a list of events. Check that BRAINCHAIN_WATCH_URL names a running \`brainchain-mcp watch --serve\`.`);
  }
  return { watching: true, watcher: watcher.origin, readAt: body.readAt, events: body.events, next: body.next, more: body.more === true };
}
