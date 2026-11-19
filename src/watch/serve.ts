import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Deliveries } from "./deliver.js";
import { DEFAULT_LIMIT, knownKind, matches, MAX_LIMIT, type EventLog, type Query, type WatchEvent } from "./events.js";
import { DeliveryError } from "./net.js";

/** The most tokens or kinds one request can filter by. */
export const MAX_FILTERS = 50;

const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** A query the watcher cannot take, with what is wrong with it. */
export class QueryError extends Error {}

const list = (value: string | null) => (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);

/** Kinds and tokens to keep, checked; throws what is wrong. */
export function filters(kinds: readonly string[], tokens: readonly string[]): Pick<Query, "kinds" | "tokens"> {
  if (kinds.length > MAX_FILTERS) throw new QueryError(`kinds can name at most ${MAX_FILTERS} kinds.`);
  const unknown = kinds.filter((kind) => !knownKind(kind));
  if (unknown.length) throw new QueryError(`Unknown kind${unknown.length === 1 ? "" : "s"}: ${unknown.slice(0, 5).join(", ")}.`);
  if (tokens.length > MAX_FILTERS) throw new QueryError(`tokens can name at most ${MAX_FILTERS} tokens.`);
  if (tokens.some((token) => token.length > 80 || /[\p{Cc}\s]/u.test(token))) throw new QueryError("Each token is a contract address, a symbol or BitGo's id for it, at most 80 characters.");
  return { ...(kinds.length ? { kinds: [...kinds] } : {}), ...(tokens.length ? { tokens: [...tokens] } : {}) };
}

/** The query of `GET /events`, checked; throws what is wrong with it. */
export function eventsQuery(params: URLSearchParams): Query {
  const query: Query = { ...filters(list(params.get("kinds")), list(params.get("tokens"))) };
  const since = params.get("since");
  if (since !== null && since !== "") {
    if (/^\d{1,15}$/.test(since)) query.since = { id: Number(since) };
    else if (ISO.test(since) && !Number.isNaN(Date.parse(since))) query.since = { time: Date.parse(since) };
    else throw new QueryError("since must be an event id, such as the next of an earlier answer, or a time in ISO 8601, such as 2026-11-19T00:00:00Z.");
  }
  const limit = params.get("limit");
  if (limit !== null && limit !== "") {
    if (!/^\d{1,4}$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_LIMIT) throw new QueryError(`limit must be a whole number from 1 to ${MAX_LIMIT}; without it the answer holds up to ${DEFAULT_LIMIT} events.`);
    query.limit = Number(limit);
  }
  const baseline = params.get("baseline");
  if (baseline !== null) query.baseline = baseline === "1" || baseline === "true";
  return query;
}

export interface Health {
  ok: boolean;
  [key: string]: unknown;
}

export interface ServeLimits {
  /** Requests one address can make in a minute, across every route. */
  perMinute: number;
  /** Watches one address can make in an hour. */
  watchesPerHour: number;
  /** Streams one address can hold open, and streams in all. */
  streamsPerAddress: number;
  streams: number;
  /** The largest request body taken, in bytes. */
  body: number;
  /** The most events a resumed stream is sent before it goes on live. */
  replay: number;
}

export const SERVE_LIMITS: ServeLimits = { perMinute: 120, watchesPerHour: 10, streamsPerAddress: 5, streams: 500, body: 4096, replay: 1000 };
export const KEEPALIVE_MS = 20_000;

export interface ServeOptions {
  log: EventLog;
  health: () => Health;
  deliveries?: Deliveries;
  /** Behind a proxy that appends the client's address to X-Forwarded-For, such as Render's, take the address from there. */
  trustProxy?: boolean;
  limits?: ServeLimits;
  clock?: () => number;
}

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

/** The public reads, which any page may fetch: they carry no credentials and change nothing. */
const OPEN = { "Access-Control-Allow-Origin": "*" };

/** A request's client: the socket's address, or behind a trusted proxy the address it appended last. */
export function clientOf(request: IncomingMessage, trustProxy: boolean): string {
  const forwarded = trustProxy ? request.headers["x-forwarded-for"] : undefined;
  const last = (Array.isArray(forwarded) ? forwarded.at(-1) : forwarded)?.split(",").at(-1)?.trim();
  return last || request.socket.remoteAddress || "unknown";
}

/** Counts per address in a window, forgetting an address once its window is over. */
class Window {
  private readonly seen = new Map<string, number[]>();
  constructor(
    private readonly size: number,
    private readonly ms: number,
  ) {}

  /** Counts a request; false when the address is over its count for the window. */
  take(address: string, now: number): boolean {
    const times = (this.seen.get(address) ?? []).filter((at) => at > now - this.ms);
    if (times.length >= this.size) {
      this.seen.set(address, times);
      return false;
    }
    times.push(now);
    this.seen.set(address, times);
    if (this.seen.size > 50_000) for (const [key, kept] of this.seen) if (kept.every((at) => at <= now - this.ms)) this.seen.delete(key);
    return true;
  }
}

const WATCH_ID = /^[\w-]{22}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A request body as JSON, refused when it is not JSON or larger than `max` bytes. */
async function json(request: IncomingMessage, max: number): Promise<unknown> {
  if (!/^application\/json\b/i.test(request.headers["content-type"] ?? "")) throw new HttpError(415, "Send the body as application/json.");
  if (Number(request.headers["content-length"] ?? 0) > max) throw new HttpError(413, `The body can be at most ${max} bytes.`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, `The body can be at most ${max} bytes.`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "The body is not JSON.");
  }
}

/** A new watch's request, checked. */
function watchRequest(body: unknown): { url: string; kinds?: string[]; tokens?: string[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Send {url, kinds?, tokens?}.");
  const { url, kinds = [], tokens = [], ...rest } = body as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length) throw new HttpError(400, `Unknown field${extra.length === 1 ? "" : "s"}: ${extra.slice(0, 5).join(", ")}. A watch takes url, kinds and tokens.`);
  if (typeof url !== "string") throw new HttpError(400, "url is required: the https address to send events to.");
  for (const [name, value] of [["kinds", kinds], ["tokens", tokens]] as const) if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new HttpError(400, `${name} must be a list of strings.`);
  try {
    const kept = filters(kinds as string[], tokens as string[]);
    return { url, ...(kept.kinds ? { kinds: [...kept.kinds] } : {}), ...(kept.tokens ? { tokens: [...kept.tokens] } : {}) };
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}

const bearer = (request: IncomingMessage) => /^Bearer ([\w-]{20,100})$/.exec(request.headers.authorization ?? "")?.[1];

export interface Served {
  server: Server;
  /** Sends published events to the open streams that want them. */
  publish(events: readonly WatchEvent[]): void;
  close(): void;
}

/**
 * The watcher's HTTP surface. Reads: `GET /events`, `GET /events/stream` (server-sent events, resumed from Last-Event-ID),
 * `GET /health` (503 while a source keeps failing) and `GET /health/live`. Watches: `POST /watches`, and `GET` or `DELETE
 * /watches/:id` with the watch's manage token. Nothing lists watches. Every address is held to `perMinute` requests.
 */
export function serveEvents({ log, health, deliveries, trustProxy = false, limits = SERVE_LIMITS, clock = Date.now }: ServeOptions): Served {
  const perMinute = new Window(limits.perMinute, 60_000);
  const creations = new Window(limits.watchesPerHour, 3_600_000);
  const streams = new Set<{ response: ServerResponse; address: string; wanted: Pick<Query, "kinds" | "tokens">; cursor: number }>();

  const send = (response: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) => {
    response.writeHead(status, { ...HEADERS, ...extra, "Content-Type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify(value)}\n`);
  };
  const frame = (event: WatchEvent) => `id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;

  function stream(request: IncomingMessage, response: ServerResponse, url: URL, address: string): void {
    const wanted = filters(list(url.searchParams.get("kinds")), list(url.searchParams.get("tokens")));
    if (streams.size >= limits.streams) throw new HttpError(503, "The watcher has as many streams open as it takes. Try again later, or read GET /events.");
    if ([...streams].filter((open) => open.address === address).length >= limits.streamsPerAddress) throw new HttpError(429, `An address can hold ${limits.streamsPerAddress} streams open at a time.`);
    const resume = request.headers["last-event-id"] ?? url.searchParams.get("since") ?? undefined;
    if (resume !== undefined && !/^\d{1,15}$/.test(String(resume))) throw new HttpError(400, "Last-Event-ID and since take an event id.");
    response.writeHead(200, { ...HEADERS, ...OPEN, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    response.write("retry: 5000\n\n");
    const open = { response, address, wanted, cursor: resume === undefined ? log.publishedThrough : Number(resume) };
    const backlog = log.after(open.cursor).filter((event) => !event.baseline && matches(event, wanted));
    if (backlog.length > limits.replay) response.write(`event: gap\ndata: ${JSON.stringify({ skipped: backlog.length - limits.replay, readWith: "GET /events?since=" })}\n\n`);
    for (const event of backlog.slice(-limits.replay)) response.write(frame(event));
    open.cursor = Math.max(open.cursor, log.publishedThrough);
    streams.add(open);
    const beat = setInterval(() => response.write(": keepalive\n\n"), KEEPALIVE_MS);
    const done = () => {
      clearInterval(beat);
      streams.delete(open);
    };
    request.on("close", done);
    response.on("error", done);
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = clientOf(request, trustProxy);
    if ((request.url ?? "").length > 2048) throw new HttpError(414, "The address is too long.");
    if (!perMinute.take(address, clock())) throw new HttpError(429, `An address can make ${limits.perMinute} requests a minute.`);
    const url = new URL(request.url ?? "/", "http://watcher");
    const method = request.method ?? "GET";
    const reading = method === "GET" || method === "HEAD";
    if (url.pathname === "/health/live" && reading) return send(response, 200, { ok: true });
    if (url.pathname === "/health" && reading) {
      const state = health();
      return send(response, state.ok ? 200 : 503, state, OPEN);
    }
    if (url.pathname === "/events" && reading) return send(response, 200, { readAt: new Date(clock()).toISOString(), ...log.query(eventsQuery(url.searchParams)) }, OPEN);
    if (url.pathname === "/events/stream" && reading) return stream(request, response, url, address);
    if (url.pathname === "/watches" && method === "POST") {
      if (!deliveries) throw new HttpError(404, "This watcher sends no events.");
      if (!creations.take(address, clock())) throw new HttpError(429, `An address can make ${limits.watchesPerHour} watches an hour.`);
      const wanted = watchRequest(await json(request, limits.body));
      try {
        const made = await deliveries.create(wanted, address);
        const signing =
          made.format === "webhook"
            ? `Each delivery is a POST of one event as JSON, with X-BrainChain-Timestamp and X-BrainChain-Signature: v1= then the hex HMAC-SHA256, keyed with secret, of the timestamp, a full stop and the body. Refuse one whose timestamp is more than 300 seconds off.`
            : `Events go out as ${made.format === "discord" ? "Discord" : made.format === "slack" ? "Slack" : "Telegram"} messages, one line each.`;
        return send(response, 201, { ...made, signing });
      } catch (error) {
        if (error instanceof DeliveryError) throw new HttpError(400, error.message);
        throw error;
      }
    }
    const id = /^\/watches\/([^/]+)$/.exec(url.pathname)?.[1];
    if (id !== undefined && (method === "GET" || method === "DELETE")) {
      const manage = bearer(request);
      // An id that is not one, a missing token and a wrong token all answer the same.
      const gone = () => new HttpError(404, "No such watch, or not with that manage token.");
      if (!deliveries || !WATCH_ID.test(id) || !manage) throw gone();
      if (method === "DELETE") {
        if (!deliveries.remove(id, manage)) throw gone();
        response.writeHead(204, HEADERS);
        return void response.end();
      }
      const status = deliveries.status(id, manage);
      if (!status) throw gone();
      return send(response, 200, status);
    }
    if (["/events", "/events/stream", "/health", "/health/live", "/watches"].includes(url.pathname) || id !== undefined) throw new HttpError(405, "That method is not served here.");
    throw new HttpError(404, "Not found. The watcher serves GET /events, GET /events/stream, GET /health, POST /watches and GET or DELETE /watches/:id.");
  }

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) return void response.end();
      if (error instanceof HttpError) return send(response, error.status, { error: error.message }, error.status === 429 ? { "Retry-After": "60" } : {});
      if (error instanceof QueryError) return send(response, 400, { error: error.message });
      // Anything else is the watcher's own failure, and the answer says nothing of how.
      return send(response, 500, { error: "Something went wrong reading that. Try again." });
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    publish(events) {
      for (const open of streams) {
        for (const event of events) {
          if (event.id <= open.cursor) continue;
          open.cursor = event.id;
          if (!event.baseline && matches(event, open.wanted)) open.response.write(frame(event));
        }
      }
    },
    close() {
      for (const { response } of streams) response.end();
      streams.clear();
      server.close();
    },
  };
}
