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

/** Whether an event passes a filter of kinds and tokens; an empty filter passes everything. */
export const matches = (event: WatchEvent, { kinds, tokens }: Pick<Query, "kinds" | "tokens">) =>
  (!kinds?.length || kinds.some((kind) => kindMatches(event.kind, kind))) && (!tokens?.length || tokens.some((token) => tokenMatches(event, token)));

/** Reads a file of JSON lines, dropping a last line a crash cut short, which the next write would otherwise run into. */
function lines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const end = text.lastIndexOf("\n") + 1;
  if (end < text.length) truncateSync(path, Buffer.byteLength(text.slice(0, end)));
  return text
    .slice(0, end)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
}

/**
 * The watcher's record: one JSON line per event in `events.jsonl`, appended and never rewritten, with an index in memory.
 * An event is written the moment it is found, and its context is read after and appended to `context.jsonl`. An event is
 * published, which is when it is served, streamed and sent, once its context is settled and every event before it is
 * published, so ids reach readers in order and a cursor never skips one. Baseline rows are published as they are written.
 */
export class EventLog {
  readonly path: string;
  private readonly contextPath: string;
  private readonly events: WatchEvent[] = [];
  private readonly keys = new Set<string>();
  private readonly byToken = new Map<string, WatchEvent[]>();
  private readonly unsettled = new Set<number>();
  private published = 0;
  private fd: number;
  private contextFd: number;

  constructor(dir: string) {
    this.path = join(dir, "events.jsonl");
    this.contextPath = join(dir, "context.jsonl");
    for (const event of lines(this.path) as WatchEvent[]) {
      this.index(event);
      if (!event.baseline) this.unsettled.add(event.id);
    }
    for (const { id, context } of lines(this.contextPath) as { id: number; context: Record<string, unknown> }[]) {
      const event = this.events[id - 1];
      if (!event) continue;
      event.context = context;
      this.unsettled.delete(id);
    }
    this.advance();
    this.fd = openSync(this.path, "a");
    this.contextFd = openSync(this.contextPath, "a");
  }

  private index(event: WatchEvent): void {
    this.events.push(event);
    this.keys.add(dedupeKey(event));
    const key = tokenKey(event);
    this.byToken.set(key, [...(this.byToken.get(key) ?? []), event]);
  }

  /** Moves the published mark up to the first event whose context is not settled, and returns the events it passed. */
  private advance(): WatchEvent[] {
    const passed: WatchEvent[] = [];
    while (this.published < this.events.length && !this.unsettled.has(this.published + 1)) passed.push(this.events[this.published++]!);
    return passed;
  }

  get lastId(): number {
    return this.events.at(-1)?.id ?? 0;
  }

  /** The id of the last published event. */
  get publishedThrough(): number {
    return this.published;
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

  /** New events whose context is not settled yet, oldest first. */
  pending(): WatchEvent[] {
    return [...this.unsettled].sort((a, b) => a - b).map((id) => this.events[id - 1]!);
  }

  /**
   * Numbers and writes the rows that are not in the log yet, in one write that is flushed to disk before it returns, and
   * returns them with the events that became published. Two rows with the same kind, token and ref are one event.
   */
  append(rows: readonly (Found & { observedAt: string })[]): { written: WatchEvent[]; published: WatchEvent[] } {
    const fresh: WatchEvent[] = [];
    const seen = new Set<string>();
    let id = this.lastId;
    for (const { baseline, observedAt, ...found } of rows) {
      const key = dedupeKey(found);
      if (this.keys.has(key) || seen.has(key)) continue;
      seen.add(key);
      fresh.push({ id: ++id, ...found, observedAt, context: {}, ...(baseline ? { baseline } : {}) });
    }
    if (fresh.length === 0) return { written: [], published: [] };
    writeSync(this.fd, fresh.map((event) => `${JSON.stringify(event)}\n`).join(""));
    fsyncSync(this.fd);
    for (const event of fresh) {
      this.index(event);
      if (!event.baseline) this.unsettled.add(event.id);
    }
    return { written: fresh, published: this.advance() };
  }

  /** Writes an event's context, and returns the events that became published, in order. */
  settle(id: number, context: Record<string, unknown>): WatchEvent[] {
    if (!this.unsettled.has(id)) return [];
    writeSync(this.contextFd, `${JSON.stringify({ id, context })}\n`);
    fsyncSync(this.contextFd);
    this.events[id - 1]!.context = context;
    this.unsettled.delete(id);
    return this.advance();
  }

  /** The published events after an id, oldest first. */
  after(id: number): WatchEvent[] {
    return this.events.slice(Math.max(0, id), this.published);
  }

  /**
   * The published events that match, oldest first. With `since`, those after it, up to `limit`; without it, the newest
   * `limit`. Rows from the baseline are left out unless asked for.
   */
  query({ since, kinds, tokens, limit = DEFAULT_LIMIT, baseline = false }: Query = {}): Page {
    const end = this.published;
    const matching = this.events.slice(0, end).filter((event) => (baseline || !event.baseline) && matches(event, { kinds, tokens }));
    const after = !since ? matching : "id" in since ? matching.filter((event) => event.id > since.id) : matching.filter((event) => Date.parse(event.observedAt) >= since.time);
    const events = since ? after.slice(0, limit) : after.slice(-limit);
    const more = after.length > events.length;
    // Once nothing was held back, the caller has seen everything that matches up to the published mark, and goes on from there.
    const next = since && more ? events.at(-1)!.id : Math.max(since && "id" in since ? since.id : 0, end);
    return { events, next, more };
  }

  close(): void {
    closeSync(this.fd);
    closeSync(this.contextFd);
  }
}
