import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { countsLine, type EventCounts } from "../dataset/counts.js";
import { BASE_NAMES } from "./chain.js";
import { matches, type EventLog, type WatchEvent } from "./events.js";
import { DeliveryError, webhookUrl, type Post, type Sent } from "./net.js";

/** How a watch's events are sent: signed JSON, or the message shape of the chat service its URL belongs to. */
export type Format = "webhook" | "discord" | "slack" | "telegram";

export interface Watch {
  /** 128 random bits: never listed, so it cannot be guessed. */
  id: string;
  url: string;
  format: Format;
  kinds?: string[];
  tokens?: string[];
  /** Signs each delivery to a plain webhook; the receiver checks it with the same secret. */
  secret: string;
  /** The SHA-256 of the token that removes the watch; the token itself is given out once and not kept. */
  manageHash: string;
  /** The SHA-256 of the address that made it, for the cap on watches per address. */
  owner: string;
  createdAt: string;
  /** The last event id delivered, or passed over as not matching. */
  cursor: number;
  delivered: number;
  failures: number;
  /** When the next try is due, after a failure. */
  retryAt?: number;
  lastError?: string;
  /** Set while the endpoint has asked the watcher to wait, which is not a failure: `tries` waits in a row, since `since`. */
  limited?: { since: string; until: string; tries: number; global?: boolean };
  /** The endpoint's last answer that was not a success, for the watcher's operator only: never shown to the watch's maker. */
  lastAnswer?: Answer;
  /** Set once the watch is switched off after failing `MAX_FAILURES` times in a row. */
  off?: { at: string; reason: string };
  /** Events it was sent before their context was finished, whose finished context is still to be sent, oldest first. */
  updates?: number[];
}

/** A failing watch is tried again after these waits, then switched off: about two hours from the first failure. */
export const RETRY_MS = [10_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
export const MAX_FAILURES = RETRY_MS.length + 1;
/** The longest single wait an endpoint's rate limit is taken at; a longer one is asked again after this. */
export const MAX_WAIT_MS = 60 * 60_000;
/** A watch whose endpoint has done nothing but ask it to wait for this long is switched off. */
export const LIMITED_OFF_MS = 24 * 60 * 60_000;
/** A chat is sent at most one message in this long; whatever comes up in between goes as one message at its end. */
export const GATHER_MS = 5_000;
/** The longest message each chat service takes, in characters. */
export const TEXT_LIMIT: Record<Exclude<Format, "webhook">, number> = { discord: 2000, slack: 4000, telegram: 4096 };
/** A plain webhook's receiver should refuse a delivery whose timestamp is further off than this. */
export const TOLERANCE_S = 300;

/** An endpoint's answer as the watcher's operator sees it, with what in the watch's URL works as a key taken out. */
export interface Answer {
  at: string;
  status: number;
  /** The first 300 characters. */
  body: string;
  headers: Record<string, string>;
}

/** The text with the parts of the URL that can be keys cut out: long path segments and query values, or ones with a digit. */
export function scrub(text: string, url: string): string {
  const { pathname, searchParams } = new URL(url);
  const keys = [...pathname.split("/"), ...searchParams.values()].filter((part) => part.length >= 20 || (part.length >= 6 && /\d/.test(part)));
  // Longest first, so a key that holds a shorter one is cut whole.
  return keys.sort((a, b) => b.length - a.length).reduce((out, key) => out.split(key).join("…"), text);
}

const msOf = (seconds: unknown): number | undefined => {
  const value = typeof seconds === "number" ? seconds : typeof seconds === "string" && seconds.trim() ? Number(seconds) : NaN;
  return Number.isFinite(value) && value >= 0 ? value * 1000 : undefined;
};

function jsonOf(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The wait a 429 asks for, as each service gives it: Discord's `retry_after` and `global` in its JSON, Telegram's
 * `parameters.retry_after`, else `Retry-After` in seconds or as a date, else `X-RateLimit-Reset-After`. A `global` limit
 * holds every delivery to that service. So does a Discord 429 that is not Discord's own JSON: that comes from the network
 * in front of Discord, which limits the watcher's address as a whole.
 */
export function limitOf(format: Format, sent: Sent, now: number): { ms?: number; global: boolean } {
  const headers = sent.headers ?? {};
  const json = jsonOf(sent.body);
  const date = headers["retry-after"] && !/^\s*\d/.test(headers["retry-after"]) ? Date.parse(headers["retry-after"]) - now : NaN;
  const ms =
    msOf(json?.retry_after) ??
    msOf((json?.parameters as { retry_after?: unknown } | undefined)?.retry_after) ??
    msOf(headers["retry-after"]) ??
    (date >= 0 ? date : undefined) ??
    msOf(headers["x-ratelimit-reset-after"]);
  const global = format === "discord" && (json?.global === true || headers["x-ratelimit-global"] === "true" || headers["x-ratelimit-scope"] === "global" || !json);
  return { ...(ms !== undefined ? { ms } : {}), global };
}

/** How long to hold the next post to a webhook after a success that used the last of its rate-limit bucket. */
export function paceOf(sent: Sent): number | undefined {
  const headers = sent.headers ?? {};
  return headers["x-ratelimit-remaining"] === "0" ? msOf(headers["x-ratelimit-reset-after"]) : undefined;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const token = (bytes: number) => randomBytes(bytes).toString("base64url");
export const ownerOf = (address: string) => hash(`brainchain-watch:${address}`).slice(0, 32);

/** Which format a URL takes, from the chat services' own webhook and bot URLs; anything else is a plain webhook. */
export function formatOf(url: URL): Format {
  const host = url.hostname.toLowerCase();
  if (/^(?:ptb\.|canary\.)?discord(?:app)?\.com$/.test(host) && /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(url.pathname)) return "discord";
  if (host === "hooks.slack.com" && /^\/(?:services|triggers)\/[\w/]+$/.test(url.pathname)) return "slack";
  if (host === "api.telegram.org" && /^\/bot\d+:[\w-]+\/sendMessage$/.test(url.pathname)) {
    if (!/^-?\d+$|^@\w{5,}$/.test(url.searchParams.get("chat_id") ?? "")) throw new DeliveryError("A Telegram url needs the chat to send to, as ?chat_id= with the chat's id or @name.");
    return "telegram";
  }
  return "webhook";
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const EXPLORER = "https://robinhoodchain.blockscout.com/tx/";

/** "$38.3M" for a dollar figure written out in full. */
export function compact(usd: string): string {
  const value = Number(usd.replace(/[$,]/g, ""));
  if (!Number.isFinite(value)) return usd;
  for (const [size, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) if (value >= size) return `$${(value / size).toFixed(1).replace(/\.0$/, "")}${unit}`;
  return `$${value.toFixed(value < 1 ? 4 : 0)}`;
}

/** What changed, in a few words, for a chat message. */
function change(event: WatchEvent, name: string): string {
  const detail = event.detail as Record<string, unknown>;
  const maker = (detail.maker as { name?: string } | undefined)?.name ?? "A followed wallet";
  switch (event.kind) {
    case "pool.created":
      return `New ${event.source} pool for ${name}, paired with ${detail.pairedWith === "ETH" ? "ETH" : (BASE_NAMES[String(detail.pairedWith).toLowerCase()] ?? short(String(detail.pairedWith)))}.`;
    case "maker.approval":
      return `${maker}'s wallet approved ${name} for the first time${detail.confirmed ? "" : ", by the token's log only"}.`;
    case "maker.receipt":
      return `${maker}'s wallet received ${name} for the first time.`;
    case "maker.pool_queued":
      return `${maker}'s multisig queued a ${String(detail.venue)} pool of ${name} for its trading contracts to trade, the first for this token${detail.confirmed ? "" : ", by the registry's log only"}.`;
    case "bitgo.pr_opened":
      return `A pull request in BitGo's code adds ${name} to its Robinhood Chain tokens.`;
    case "bitgo.merged":
      return `BitGo merged ${name} into its Robinhood Chain tokens.`;
    case "bitgo.released":
      return `BitGo's @bitgo/statics ${String(detail.version)} includes ${name}.`;
    case "trustwallet.pr_opened":
      return `A pull request adds ${name} to Trust Wallet's token list.`;
    case "trustwallet.merged":
      return `Trust Wallet added ${name} to its token list.`;
    case "metamask.pr_opened":
      return `A pull request adds ${name} to MetaMask's token list.`;
    case "metamask.merged":
      return `MetaMask added ${name} to its token list.`;
    case "robinhood.pair_added":
      return `${name} entered the pair list Robinhood serves to API clients, ${detail.tradable ? "tradable" : "price only"}${typeof detail.pairsRead === "number" ? ` (${detail.pairsRead} pairs read)` : ""}.`;
    case "robinhood.tradability_changed":
      return `${name} is ${detail.tradable ? "tradable" : "price only"} now in the pair list Robinhood serves to API clients.`;
    case "robinhood.page_added":
      return `Robinhood has a page for ${name} now.`;
    case "kucoin.listed":
      return `KuCoin lists ${name} on Robinhood Chain.`;
    case "gate.listed":
      return `Gate lists ${name} on Robinhood Chain.`;
    case "lifi.listed":
      return `LI.FI routes ${name} on Robinhood Chain.`;
    case "coingecko.listed":
      return `CoinGecko lists ${name} on Robinhood Chain.`;
    case "venue.listed":
      return `${event.source} added a ${MARKET_WORDS[String(detail.type)] ?? "market"} for ${name}, ${String(detail.market)}: ${statusWords(detail)}.${bySymbol(detail)}`;
    case "venue.status_changed":
      return `${event.source}'s ${String(detail.market)} ${MARKET_WORDS[String(detail.type)] ?? "market"} for ${name} is ${statusWords(detail)} now; it was ${STATUS_WORDS[String(detail.was)] ?? String(detail.was)}.${bySymbol(detail)}`;
    case "venue.announced":
      return `${event.source} published an announcement that names ${name}.${bySymbol(detail)}`;
  }
}

const MARKET_WORDS: Record<string, string> = { spot: "spot market", perpetual: "perpetual futures market", futures: "futures market" };
const STATUS_WORDS: Record<string, string> = { trading: "trading", auction: "in its opening auction", "pre-trading": "not trading yet", halted: "halted" };

/** A market's status in words, with the start the venue gives for one that has not opened. */
function statusWords(detail: Record<string, unknown>): string {
  const words = STATUS_WORDS[String(detail.status)] ?? String(detail.status);
  const opens = typeof detail.opens === "string" ? Date.parse(detail.opens) : NaN;
  return detail.status === "pre-trading" && opens > Date.now() ? `${words}; the venue gives ${new Date(opens).toISOString().slice(0, 16).replace("T", " ")} UTC as its start` : words;
}

const bySymbol = (detail: Record<string, unknown>) => (detail.match === "symbol" ? " Matched by symbol only: nothing the venue gives confirms it is this token." : "");

/** A name or symbol that reads as a web address or a handle, which a chat would turn into a link or a mention from our bot. */
const LINKISH = /https?:|www\.|[\w-]\.[a-z]{2,}\b|@\w|t\.me\b|discord\.gg/i;

/**
 * One line for a chat: what changed, the token, its worth now and the link to check it by. A token's name is whatever its
 * deployer wrote, so a name that reads as a link is left out and the token goes by its address.
 */
export function line(event: WatchEvent): string {
  const { address, symbol, name } = event.token;
  const safe = (text: string | null) => (text && !LINKISH.test(text) ? text : undefined);
  const label = [safe(name), symbol && symbol !== name ? safe(symbol) : undefined].filter(Boolean).join(" ") || safe(symbol) || (address ? "a token" : "a token named like a link");
  const named = address ? `${label} (${short(address)})` : label;
  const worth = event.context.worth as { marketCapUsd?: string; depth2pctUsd?: string } | null | undefined;
  const value = worth?.marketCapUsd ? ` Worth ${compact(worth.marketCapUsd)} now${worth.depth2pctUsd ? `, ${compact(worth.depth2pctUsd)} of depth within 2%` : ""}.` : "";
  const link = /^0x[0-9a-f]{64}$/i.test(event.ref) ? `${EXPLORER}${event.ref}` : event.ref.split("@")[0]!;
  return `${change(event, named)}${value}${countsLine(event.context.counts as EventCounts | undefined)} ${link}`;
}

/** A chat's follow-up for an event whose worth was read after it went out: one short line. */
export function followUp(event: WatchEvent): string | undefined {
  const worth = event.context.worth as { marketCapUsd?: string; depth2pctUsd?: string } | null | undefined;
  if (!worth?.marketCapUsd) return undefined;
  const { address, symbol, name } = event.token;
  const label = [name, symbol].find((text) => text && !LINKISH.test(text)) ?? "the token";
  return `Worth now for ${label}${address ? ` (${short(address)})` : ""}: ${compact(worth.marketCapUsd)} market cap${worth.depth2pctUsd ? `, ${compact(worth.depth2pctUsd)} of depth within 2%` : ""}.`;
}

const BASE_HEADERS = { "Content-Type": "application/json", "User-Agent": "brainchain-watch" };

/** One chat message of several lines, one a change, in the chat service's own shape: no pings, no previews. */
export function chat(watch: Pick<Watch, "format" | "url">, texts: readonly string[]): { body: string; headers: Record<string, string> } {
  const limit = TEXT_LIMIT[watch.format as keyof typeof TEXT_LIMIT];
  switch (watch.format) {
    case "slack":
      return { body: JSON.stringify({ text: texts.join("\n").slice(0, limit).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), unfurl_links: false, unfurl_media: false }), headers: BASE_HEADERS };
    case "telegram": {
      const chat = new URL(watch.url).searchParams.get("chat_id")!;
      return { body: JSON.stringify({ chat_id: chat, text: texts.join("\n").slice(0, limit), link_preview_options: { is_disabled: true } }), headers: BASE_HEADERS };
    }
    default:
      return { body: JSON.stringify({ content: texts.join("\n").slice(0, limit), allowed_mentions: { parse: [] }, flags: 4 }), headers: BASE_HEADERS };
  }
}

/** What a watch posts for an event, or for an event's finished context with `update`, and the headers that go with it. */
export function message(watch: Pick<Watch, "id" | "format" | "secret" | "url">, event: WatchEvent, now: number, update = false): { body: string; headers: Record<string, string> } {
  if (watch.format !== "webhook") return chat(watch, [update ? (followUp(event) ?? "") : line(event)]);
  const body = JSON.stringify(update ? { type: "update", id: event.id, kind: event.kind, token: event.token, context: event.context } : event);
  const timestamp = String(Math.floor(now / 1000));
  const signature = createHmac("sha256", watch.secret).update(`${timestamp}.${body}`).digest("hex");
  return {
    body,
    headers: { ...BASE_HEADERS, "X-BrainChain-Watch": watch.id, "X-BrainChain-Event": String(event.id), ...(update ? { "X-BrainChain-Update": "1" } : {}), "X-BrainChain-Timestamp": timestamp, "X-BrainChain-Signature": `v1=${signature}` },
  };
}

export interface Limits {
  /** Watches one address can have at a time. */
  perOwner: number;
  total: number;
}

export const LIMITS: Limits = { perOwner: 5, total: 500 };

export interface DeliveryOptions {
  dir: string;
  log: EventLog;
  post: Post;
  limits?: Limits;
  clock?: () => number;
  /** Told when a watch is switched off, by id only: a URL can hold a chat service's token. */
  say?: (message: string) => void;
  /** How long a resolved host is checked for being public when a watch is made; a test passes its own. */
  check?: (url: URL) => Promise<void>;
  /** `GATHER_MS` unless a test passes its own. */
  gatherMs?: number;
}

/** What one post takes from a watch's queue: its updates, then its events, and where its cursor ends. */
interface Batch {
  /** Nothing when what was taken needs no post: events that do not match, or an update with nothing to say. */
  message?: { body: string; headers: Record<string, string> };
  updates: number[];
  cursor: number;
  /** The events sent, each with the context it went out with. */
  events: { event: WatchEvent; context: Record<string, unknown> }[];
  /** The event a failure is reported on. */
  about: number;
}

interface Outcome {
  sent?: Sent;
  /** Written for the watch's maker; set unless the post went through. */
  failure?: string;
}

/**
 * The watches, kept in `watches.json` beside the log, and their deliveries: each watch is sent the published events that
 * match it, in order, from the event after the one published when it was made. A plain webhook gets one post an event; a
 * chat gets one message at most every `GATHER_MS`, holding every line that came up since, up to the service's limit. A
 * failure is tried again after each wait in `RETRY_MS`, and a watch that fails `MAX_FAILURES` times in a row is switched
 * off, with the reason, which `status` gives to whoever holds its manage token. A 429 is not a failure: the watch waits as
 * long as the endpoint asks, and a Discord limit on the watcher's whole address holds every Discord watch.
 */
export class Deliveries {
  private readonly path: string;
  private readonly watches = new Map<string, Watch>();
  private readonly sending = new Set<string>();
  /** Until when posts are held, by webhook URL for one bucket, or by format for a limit on all of a service's deliveries. */
  private readonly holds = new Map<string, number>();
  private readonly lastSent = new Map<string, number>();
  private readonly options: DeliveryOptions;
  private readonly clock: () => number;
  private readonly gather: number;
  private timer?: NodeJS.Timeout;

  constructor(options: DeliveryOptions) {
    this.options = options;
    this.clock = options.clock ?? Date.now;
    this.gather = options.gatherMs ?? GATHER_MS;
    this.path = join(options.dir, "watches.json");
    if (existsSync(this.path)) for (const watch of JSON.parse(readFileSync(this.path, "utf8")) as Watch[]) this.watches.set(watch.id, watch);
  }

  private save(): void {
    const next = `${this.path}.next`;
    writeFileSync(next, `${JSON.stringify([...this.watches.values()])}\n`, { mode: 0o600 });
    renameSync(next, this.path);
  }

  get active(): number {
    return [...this.watches.values()].filter((watch) => !watch.off).length;
  }

  /** Watches switched off this long ago are dropped; until then they count toward their owner's cap, so failing ones cannot be cycled. */
  static readonly KEEP_OFF_MS = 7 * 24 * 60 * 60_000;

  /** Makes a watch, after checking the URL and the caps, and returns what only its maker gets: the secret and the manage token. */
  async create(request: { url: string; kinds?: string[]; tokens?: string[] }, address: string): Promise<{ id: string; secret: string; manageToken: string; format: Format; from: number }> {
    const url = webhookUrl(request.url);
    const format = formatOf(url);
    await this.options.check?.(url);
    const owner = ownerOf(address);
    const { perOwner, total } = this.options.limits ?? LIMITS;
    const held = [...this.watches.values()];
    if (held.length >= total) throw new DeliveryError("The watcher holds as many watches as it takes. Try again later.");
    if (held.filter((watch) => watch.owner === owner).length >= perOwner) throw new DeliveryError(`An address can have ${perOwner} watches at a time, switched-off ones included until they are removed. Remove one first.`);
    const manageToken = token(32);
    const watch: Watch = {
      id: token(16),
      url: url.href,
      format,
      ...(request.kinds?.length ? { kinds: request.kinds } : {}),
      ...(request.tokens?.length ? { tokens: request.tokens } : {}),
      secret: token(32),
      manageHash: hash(manageToken),
      owner,
      createdAt: new Date(this.clock()).toISOString(),
      cursor: this.options.log.publishedThrough,
      delivered: 0,
      failures: 0,
    };
    this.watches.set(watch.id, watch);
    this.save();
    return { id: watch.id, secret: watch.secret, manageToken, format, from: watch.cursor };
  }

  /** The watch whose id and manage token these are, or nothing: a wrong token and an unknown id look the same. */
  private held(id: string, manageToken: string): Watch | undefined {
    const watch = this.watches.get(id);
    const given = Buffer.from(hash(manageToken), "hex");
    const kept = Buffer.from(watch?.manageHash ?? hash(`${id}:none`), "hex");
    return timingSafeEqual(given, kept) && watch ? watch : undefined;
  }

  remove(id: string, manageToken: string): boolean {
    if (!this.held(id, manageToken)) return false;
    this.watches.delete(id);
    this.save();
    return true;
  }

  status(id: string, manageToken: string): Record<string, unknown> | undefined {
    const watch = this.held(id, manageToken);
    if (!watch) return undefined;
    const { id: _, url, secret: _s, manageHash: _m, owner: _o, lastAnswer: _a, retryAt, ...shown } = watch;
    return { id, host: new URL(url).hostname, ...shown, ...(retryAt ? { retryAt: new Date(retryAt).toISOString() } : {}) };
  }

  /** Each watch's delivery state and the endpoint's last answer that was not a success, for the operator: no URL path, secret or token. */
  report(): { watches: Record<string, unknown>[]; holding: Record<string, string> } {
    const now = this.clock();
    const watches = [...this.watches.values()].map(({ id, url, format, cursor, delivered, failures, retryAt, lastError, limited, lastAnswer, off }) => ({
      ref: id.slice(0, 6),
      host: new URL(url).hostname,
      format,
      cursor,
      delivered,
      failures,
      ...(retryAt ? { retryAt: new Date(retryAt).toISOString() } : {}),
      ...(lastError ? { lastError } : {}),
      ...(limited ? { limited } : {}),
      ...(lastAnswer ? { lastAnswer } : {}),
      ...(off ? { off } : {}),
    }));
    const holding = Object.fromEntries([...this.holds].filter(([key, until]) => !key.includes("://") && until > now).map(([key, until]) => [key, new Date(until).toISOString()]));
    return { watches, holding };
  }

  start(every = 2_000): void {
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private dirty = false;

  /** Sends each watch that is due its next event, and writes what changed once. Called on a timer, and when events are published. */
  async tick(): Promise<void> {
    const now = this.clock();
    for (const watch of this.watches.values()) {
      if (watch.off && now - Date.parse(watch.off.at) > Deliveries.KEEP_OFF_MS) {
        this.watches.delete(watch.id);
        this.dirty = true;
      }
    }
    try {
      await Promise.all(
        [...this.watches.values()]
          .filter((watch) => !watch.off && !this.sending.has(watch.id) && this.due(watch) <= now)
          .map(async (watch) => {
            this.sending.add(watch.id);
            try {
              await this.next(watch);
            } finally {
              this.sending.delete(watch.id);
            }
          }),
      );
      if (this.dirty) {
        this.dirty = false;
        this.save();
      }
    } catch (error) {
      this.dirty = true;
      this.options.say?.(`the watches could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Queues an event's finished context for each watch that was sent the event before it was finished: a plain webhook
   * gets the whole context, a chat the worth, when there is one. A watch not sent the event yet gets it finished.
   */
  update(event: WatchEvent, first?: Record<string, unknown>): void {
    // A chat whose first line already gave the worth has nothing more to be told.
    const told = Boolean((first?.worth as { marketCapUsd?: string } | null | undefined)?.marketCapUsd);
    for (const watch of this.watches.values()) {
      if (watch.off || event.baseline || watch.cursor < event.id || !matches(event, watch)) continue;
      if (watch.format !== "webhook" && (told || !followUp(event))) continue;
      watch.updates = [...new Set([...(watch.updates ?? []), event.id])].slice(-200);
      this.dirty = true;
    }
  }

  /** When a watch may post next: after its retry, its webhook's bucket, its service's hold, and for a chat its gathering. */
  private due(watch: Watch): number {
    const gathered = watch.format === "webhook" ? 0 : (this.lastSent.get(watch.id) ?? -Infinity) + this.gather;
    return Math.max(watch.retryAt ?? 0, this.holds.get(watch.url) ?? 0, this.holds.get(watch.format) ?? 0, gathered);
  }

  /** Sends a watch's queued updates, then its matching events in order, until it is caught up, held or one fails. */
  private async next(watch: Watch): Promise<void> {
    while (!watch.off && this.due(watch) <= this.clock()) {
      const batch = watch.format === "webhook" ? this.single(watch) : this.batch(watch);
      if (!batch) return;
      if (batch.message) {
        const outcome = await this.post(watch, batch.message);
        if (!this.took(watch, outcome, batch.about)) return;
        Object.assign(watch, { delivered: watch.delivered + batch.events.length, failures: 0 });
        delete watch.retryAt;
        delete watch.lastError;
        delete watch.limited;
        if (watch.format !== "webhook") this.lastSent.set(watch.id, this.clock());
      }
      if (batch.updates.length) watch.updates = watch.updates?.filter((id) => !batch.updates.includes(id));
      watch.cursor = Math.max(watch.cursor, batch.cursor);
      this.dirty = true;
      // Finished while it was on its way: the finished context follows.
      for (const { event, context } of batch.events) if (Array.isArray(context.pending) && !Array.isArray(event.context.pending)) this.update(event, context);
    }
  }

  /** A plain webhook's next post: its oldest queued update, else its next matching event. */
  private single(watch: Watch): Batch | undefined {
    const update = watch.updates?.[0];
    if (update !== undefined) {
      const event = this.options.log.all()[update - 1];
      return { ...(event ? { message: message(watch, event, this.clock(), true) } : {}), updates: [update], cursor: watch.cursor, events: [], about: update };
    }
    const waiting = this.options.log.after(watch.cursor);
    const due = waiting.find((event) => !event.baseline && matches(event, watch));
    if (due) return { message: message(watch, due, this.clock()), updates: [], cursor: due.id, events: [{ event: due, context: due.context }], about: due.id };
    const cursor = waiting.at(-1)?.id ?? watch.cursor;
    return cursor > watch.cursor ? { updates: [], cursor, events: [], about: cursor } : undefined;
  }

  /** A chat's next message: its queued updates and then its matching events, one line each, as many as the service takes. */
  private batch(watch: Watch): Batch | undefined {
    const limit = TEXT_LIMIT[watch.format as keyof typeof TEXT_LIMIT];
    const texts: string[] = [];
    let size = -1;
    const fits = (text: string) => texts.length === 0 || size + 1 + text.length <= limit;
    const take = (text: string) => {
      texts.push(text);
      size += 1 + text.length;
    };
    const queued = watch.updates ?? [];
    const updates: number[] = [];
    for (const id of queued) {
      const event = this.options.log.all()[id - 1];
      const text = event && followUp(event);
      if (text && !fits(text)) break;
      if (text) take(text);
      updates.push(id);
    }
    let cursor = watch.cursor;
    const events: Batch["events"] = [];
    if (updates.length === queued.length) {
      for (const event of this.options.log.after(watch.cursor)) {
        if (event.baseline || !matches(event, watch)) {
          cursor = event.id;
          continue;
        }
        const text = line(event);
        if (!fits(text)) break;
        take(text);
        events.push({ event, context: event.context });
        cursor = event.id;
      }
    }
    if (!updates.length && cursor === watch.cursor) return undefined;
    return { ...(texts.length ? { message: chat(watch, texts) } : {}), updates, cursor, events, about: events[0]?.event.id ?? updates[0] ?? cursor };
  }

  private async post(watch: Watch, { body, headers }: { body: string; headers: Record<string, string> }): Promise<Outcome> {
    try {
      const sent = await this.options.post(new URL(watch.url), body, headers);
      // Only the status: echoing what the endpoint said would let a watch read the answers to posts from this address.
      return sent.status >= 200 && sent.status < 300 ? { sent } : { sent, failure: `The endpoint answered ${sent.status}.` };
    } catch (error) {
      return { failure: error instanceof DeliveryError ? error.message : "The endpoint could not be reached." };
    }
  }

  /** Takes in a post's answer: true for a success, which may use the last of its bucket; else the wait asked for, or a failure. */
  private took(watch: Watch, { sent, failure }: Outcome, about: number): boolean {
    const now = this.clock();
    if (!failure) {
      const pace = sent && paceOf(sent);
      if (pace) this.holds.set(watch.url, now + pace);
      return true;
    }
    if (sent) watch.lastAnswer = { at: new Date(now).toISOString(), status: sent.status, body: scrub(sent.body, watch.url), headers: sent.headers ?? {} };
    if (sent?.status === 429) this.limit(watch, limitOf(watch.format, sent, now), about);
    else this.failed(watch, about, failure);
    this.dirty = true;
    return false;
  }

  /**
   * Holds a watch for as long as its endpoint asked, or after each wait in `RETRY_MS` when it gave none. A wait is not a
   * failure; a watch whose endpoint has asked it to wait for `LIMITED_OFF_MS` without taking a delivery is switched off.
   */
  private limit(watch: Watch, { ms, global }: { ms?: number; global: boolean }, about: number): void {
    const now = this.clock();
    const since = watch.limited?.since ?? new Date(now).toISOString();
    if (now - Date.parse(since) >= LIMITED_OFF_MS) {
      watch.off = { at: new Date(now).toISOString(), reason: `Switched off on event ${about}: the endpoint asked the watcher to wait for a day without taking a delivery. Make a new watch to start again.` };
      delete watch.retryAt;
      this.options.say?.(`watch ${watch.id} switched off after a day of rate limits.`);
      return;
    }
    const tries = (watch.limited?.tries ?? 0) + 1;
    const until = now + Math.min(MAX_WAIT_MS, Math.max(1_000, ms !== undefined ? ms + 250 : RETRY_MS[Math.min(tries, RETRY_MS.length) - 1]!));
    watch.limited = { since, until: new Date(until).toISOString(), tries, ...(global ? { global } : {}) };
    watch.retryAt = until;
    const key = global ? watch.format : watch.url;
    this.holds.set(key, Math.max(until, this.holds.get(key) ?? 0));
    if (tries === 1) this.options.say?.(`watch ${watch.id}: ${new URL(watch.url).hostname} asked for a ${Math.round((until - now) / 1000)} s wait${global ? ", for every delivery to it" : ""}.`);
  }

  /** Counts a failed try, and switches the watch off once it has failed `MAX_FAILURES` times in a row. */
  private failed(watch: Watch, about: number, failure: string): void {
    watch.failures++;
    watch.lastError = failure;
    if (watch.failures >= MAX_FAILURES) {
      watch.off = { at: new Date(this.clock()).toISOString(), reason: `Switched off after ${watch.failures} failed tries in a row on event ${about}; the last: ${failure} Make a new watch to start again.` };
      delete watch.retryAt;
      this.options.say?.(`watch ${watch.id} switched off after ${watch.failures} failed tries.`);
    } else watch.retryAt = this.clock() + RETRY_MS[watch.failures - 1]!;
  }
}
