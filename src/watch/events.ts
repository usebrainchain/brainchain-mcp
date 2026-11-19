import { closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Every kind of change the watcher records, by the source that makes it public. */
export const KINDS = [
  "pool.created",
  "maker.approval",
  "maker.receipt",
  "bitgo.pr_opened",
  "bitgo.merged",
  "bitgo.released",
  "trustwallet.pr_opened",
  "trustwallet.merged",
  "metamask.pr_opened",
  "metamask.merged",
  "robinhood.pair_added",
  "robinhood.tradability_changed",
  "robinhood.page_added",
  "kucoin.listed",
  "gate.listed",
  "lifi.listed",
  "coingecko.listed",
] as const;
export type Kind = (typeof KINDS)[number];

/** A token as the source names it. A source that knows a token by its symbol alone, such as Robinhood, gives no address. */
export interface EventToken {
  address: string | null;
  symbol: string | null;
  name: string | null;
}

export interface WatchEvent {
  /** Counts up from 1 in the order the watcher recorded the events. */
  id: number;
  kind: Kind;
  token: EventToken;
  /** The party that published the change, such as BitGo or Uniswap v4. */
  source: string;
  /** Where to check it: a link, a transaction hash or a commit. */
  ref: string;
  /** When the source dates the change, or null for a source that publishes no date. */
  at: string | null;
  /** When the watcher first saw it. */
  observedAt: string;
  detail: Record<string, unknown>;
  context: Record<string, unknown>;
  /** Set on what was already public when the watcher started reading the source, which it records and never reports as new. */
  baseline?: true;
}

/** A change as a poller finds it, before the log numbers it. `baseline` marks one that was public before the watcher began. */
export interface Found {
  kind: Kind;
  token: EventToken;
  source: string;
  ref: string;
  at: string | null;
  detail: Record<string, unknown>;
  baseline?: true;
}

/** How a token is told apart in the log: its address, else BitGo's id for it, else its symbol. */
export function tokenKey({ token, detail }: Pick<Found, "token" | "detail">): string {
  if (token.address) return token.address.toLowerCase();
  if (typeof detail.id === "string") return `bitgo:${detail.id}`;
  if (token.symbol) return `symbol:${token.symbol.toUpperCase()}`;
  return `name:${token.name ?? ""}`;
}

export const dedupeKey = (found: Pick<Found, "kind" | "token" | "detail" | "ref">) => `${found.kind}|${tokenKey(found)}|${found.ref}`;

export interface Query {
  /** An event id, for the events after it, or a time in milliseconds, for the events observed at or after it. */
  since?: { id: number } | { time: number };
  /** Kinds, or the part before the dot, such as `bitgo` for every BitGo kind. */
  kinds?: readonly string[];
  /** Addresses, symbols or BitGo ids, in any case. */
  tokens?: readonly string[];
  limit?: number;
  baseline?: boolean;
}

export interface Page {
  events: WatchEvent[];
  /** The id to pass as `since` next time. */
  next: number;
  /** Whether more events matched than `limit` let through. */
  more: boolean;
}

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

/** Whether `wanted`, a kind or the part of one before the dot, covers `kind`. */
export const kindMatches = (kind: Kind, wanted: string) => kind === wanted || kind.startsWith(`${wanted.replace(/\.\*?$/, "")}.`);

/** Whether a kind filter names only kinds the log can hold. */
export const knownKind = (wanted: string) => KINDS.some((kind) => kindMatches(kind, wanted));

function tokenMatches(event: WatchEvent, wanted: string): boolean {
  const asked = wanted.trim().toLowerCase().replace(/^\$/, "");
  const { address, symbol } = event.token;
  if (address && address.toLowerCase() === asked) return true;
  if (symbol && symbol.toLowerCase() === asked) return true;
  const id = event.detail.id;
  return typeof id === "string" && (id.toLowerCase() === asked || id.toLowerCase() === `hoodeth:${asked}`);
}

/**
 * The watcher's record: one JSON line per event in `events.jsonl`, appended and never rewritten, with an index in memory.
 * A line cut short by a crash is dropped when the log is opened, and the log goes on after the last whole line.
 */
export class EventLog {
  readonly path: string;
  private readonly events: WatchEvent[] = [];
  private readonly keys = new Set<string>();
  private readonly byToken = new Map<string, WatchEvent[]>();
  private fd: number;

  constructor(dir: string) {
    this.path = join(dir, "events.jsonl");
    if (existsSync(this.path)) this.load();
    this.fd = openSync(this.path, "a");
  }

  private load(): void {
    const text = readFileSync(this.path, "utf8");
    const end = text.lastIndexOf("\n") + 1;
    if (end < text.length) truncateSync(this.path, Buffer.byteLength(text.slice(0, end)));
    for (const line of text.slice(0, end).split("\n")) {
      if (!line.trim()) continue;
      this.index(JSON.parse(line) as WatchEvent);
    }
  }

  private index(event: WatchEvent): void {
    this.events.push(event);
    this.keys.add(dedupeKey(event));
    const key = tokenKey(event);
    this.byToken.set(key, [...(this.byToken.get(key) ?? []), event]);
  }

  get lastId(): number {
    return this.events.at(-1)?.id ?? 0;
  }

  get size(): number {
    return this.events.length;
  }

  get baselineSize(): number {
    return this.events.filter((event) => event.baseline).length;
  }

  has(found: Found): boolean {
    return this.keys.has(dedupeKey(found));
  }

  /** The events recorded for a token, oldest first. */
  forToken(found: Pick<Found, "token" | "detail">): readonly WatchEvent[] {
    return this.byToken.get(tokenKey(found)) ?? [];
  }

  /** Every event, oldest first. */
  all(): readonly WatchEvent[] {
    return this.events;
  }

  /**
   * Numbers and writes the rows that are not in the log yet, in one write that is flushed to disk before it returns, and
   * returns them. Two rows with the same kind, token and ref are one event.
   */
  append(rows: readonly (Found & { observedAt: string; context?: Record<string, unknown> })[]): WatchEvent[] {
    const fresh: WatchEvent[] = [];
    const seen = new Set<string>();
    let id = this.lastId;
    for (const { baseline, context, observedAt, ...found } of rows) {
      const key = dedupeKey(found);
      if (this.keys.has(key) || seen.has(key)) continue;
      seen.add(key);
      fresh.push({ id: ++id, ...found, observedAt, context: context ?? {}, ...(baseline ? { baseline } : {}) });
    }
    if (fresh.length === 0) return [];
    writeSync(this.fd, fresh.map((event) => `${JSON.stringify(event)}\n`).join(""));
    fsyncSync(this.fd);
    for (const event of fresh) this.index(event);
    return fresh;
  }

  /**
   * The events that match, oldest first. With `since`, those after it, up to `limit`; without it, the newest `limit`. Rows
   * from the baseline are left out unless asked for.
   */
  query({ since, kinds, tokens, limit = DEFAULT_LIMIT, baseline = false }: Query = {}): Page {
    const matching = this.events.filter(
      (event) =>
        (baseline || !event.baseline) &&
        (!kinds?.length || kinds.some((kind) => kindMatches(event.kind, kind))) &&
        (!tokens?.length || tokens.some((token) => tokenMatches(event, token))),
    );
    const after = !since ? matching : "id" in since ? matching.filter((event) => event.id > since.id) : matching.filter((event) => Date.parse(event.observedAt) >= since.time);
    const events = since ? after.slice(0, limit) : after.slice(-limit);
    const more = after.length > events.length;
    // Once nothing was held back, the caller has seen everything that matches up to the end of the log, and goes on from there.
    const next = since && more ? events.at(-1)!.id : Math.max(since && "id" in since ? since.id : 0, this.lastId);
    return { events, next, more };
  }

  close(): void {
    closeSync(this.fd);
  }
}
