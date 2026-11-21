import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { countsLine, type EventCounts } from "../dataset/counts.js";
import { BASE_NAMES } from "./chain.js";
import { matches, type EventLog, type WatchEvent } from "./events.js";
import { DeliveryError, webhookUrl, type Post } from "./net.js";

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
  /** Set once the watch is switched off after failing `MAX_FAILURES` times in a row. */
  off?: { at: string; reason: string };
  /** Events it was sent before their context was finished, whose finished context is still to be sent, oldest first. */
  updates?: number[];
}

/** A failing watch is tried again after these waits, then switched off: about two hours from the first failure. */
export const RETRY_MS = [10_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
export const MAX_FAILURES = RETRY_MS.length + 1;
/** A plain webhook's receiver should refuse a delivery whose timestamp is further off than this. */
export const TOLERANCE_S = 300;

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

/** What a watch posts for an event, or for an event's finished context with `update`, and the headers that go with it. */
export function message(watch: Pick<Watch, "id" | "format" | "secret" | "url">, event: WatchEvent, now: number, update = false): { body: string; headers: Record<string, string> } {
  const base = { "Content-Type": "application/json", "User-Agent": "brainchain-watch" };
  const text = update ? (followUp(event) ?? "") : line(event);
  switch (watch.format) {
    case "discord":
      return { body: JSON.stringify({ content: text.slice(0, 2000), allowed_mentions: { parse: [] }, flags: 4 }), headers: base };
    case "slack":
      return { body: JSON.stringify({ text: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), unfurl_links: false, unfurl_media: false }), headers: base };
    case "telegram": {
      const chat = new URL(watch.url).searchParams.get("chat_id")!;
      return { body: JSON.stringify({ chat_id: chat, text: text.slice(0, 4096), link_preview_options: { is_disabled: true } }), headers: base };
    }
    case "webhook": {
      const body = JSON.stringify(update ? { type: "update", id: event.id, kind: event.kind, token: event.token, context: event.context } : event);
      const timestamp = String(Math.floor(now / 1000));
      const signature = createHmac("sha256", watch.secret).update(`${timestamp}.${body}`).digest("hex");
      return {
        body,
        headers: { ...base, "X-BrainChain-Watch": watch.id, "X-BrainChain-Event": String(event.id), ...(update ? { "X-BrainChain-Update": "1" } : {}), "X-BrainChain-Timestamp": timestamp, "X-BrainChain-Signature": `v1=${signature}` },
      };
    }
  }
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
}

/**
 * The watches, kept in `watches.json` beside the log, and their deliveries: each watch is sent the published events that
 * match it, one at a time and in order, from the event after the one published when it was made. A failure is tried again
 * after each wait in `RETRY_MS`, and a watch that fails `MAX_FAILURES` times in a row is switched off, with the reason, which
 * `status` gives to whoever holds its manage token.
 */
export class Deliveries {
  private readonly path: string;
  private readonly watches = new Map<string, Watch>();
  private readonly sending = new Set<string>();
  private readonly options: DeliveryOptions;
  private readonly clock: () => number;
  private timer?: NodeJS.Timeout;

  constructor(options: DeliveryOptions) {
    this.options = options;
    this.clock = options.clock ?? Date.now;
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
    const { id: _, url, secret: _s, manageHash: _m, owner: _o, retryAt, ...shown } = watch;
    return { id, host: new URL(url).hostname, ...shown, ...(retryAt ? { retryAt: new Date(retryAt).toISOString() } : {}) };
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
          .filter((watch) => !watch.off && !this.sending.has(watch.id) && (watch.retryAt ?? 0) <= now)
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

  /** Sends a watch's queued updates, then its matching events in order, until it is caught up or one fails. */
  private async next(watch: Watch): Promise<void> {
    while (watch.updates?.length) {
      const event = this.options.log.all()[watch.updates[0]! - 1];
      if (event) {
        const failure = await this.send(watch, event, true);
        if (failure) return this.failed(watch, event, failure);
        watch.failures = 0;
      }
      watch.updates.shift();
      this.dirty = true;
    }
    for (;;) {
      const waiting = this.options.log.after(watch.cursor);
      const due = waiting.find((event) => !event.baseline && matches(event, watch));
      const skipped = due ? due.id - 1 : waiting.at(-1)?.id;
      if (skipped !== undefined && skipped > watch.cursor) {
        watch.cursor = skipped;
        this.dirty = true;
      }
      if (!due || watch.off) return;
      const sent = due.context;
      const unfinished = Array.isArray(sent.pending);
      const failure = await this.send(watch, due);
      if (failure) return this.failed(watch, due, failure);
      Object.assign(watch, { cursor: due.id, delivered: watch.delivered + 1, failures: 0 });
      delete watch.retryAt;
      delete watch.lastError;
      this.dirty = true;
      // Finished while it was on its way: the finished context follows.
      if (unfinished && !Array.isArray(due.context.pending)) this.update(due, sent);
    }
  }

  /** Counts a failed try, and switches the watch off once it has failed `MAX_FAILURES` times in a row. */
  private failed(watch: Watch, event: WatchEvent, failure: string): void {
    watch.failures++;
    watch.lastError = failure;
    if (watch.failures >= MAX_FAILURES) {
      watch.off = { at: new Date(this.clock()).toISOString(), reason: `Switched off after ${watch.failures} failed tries in a row on event ${event.id}; the last: ${failure} Make a new watch to start again.` };
      delete watch.retryAt;
      this.options.say?.(`watch ${watch.id} switched off after ${watch.failures} failed tries.`);
    } else watch.retryAt = this.clock() + RETRY_MS[watch.failures - 1]!;
    this.dirty = true;
  }

  /** Posts one event, or its finished context; the failure, written for the watch's maker, or nothing. */
  private async send(watch: Watch, event: WatchEvent, update = false): Promise<string | undefined> {
    const { body, headers } = message(watch, event, this.clock(), update);
    try {
      const { status } = await this.options.post(new URL(watch.url), body, headers);
      // Only the status: echoing what the endpoint said would let a watch read the answers to posts from this address.
      if (status >= 200 && status < 300) return undefined;
      return `The endpoint answered ${status}.`;
    } catch (error) {
      return error instanceof DeliveryError ? error.message : "The endpoint could not be reached.";
    }
  }
}
