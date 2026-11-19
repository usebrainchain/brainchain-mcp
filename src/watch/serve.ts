import { createServer, type Server } from "node:http";

import { DEFAULT_LIMIT, knownKind, MAX_LIMIT, type EventLog, type Query } from "./events.js";

/** The most tokens or kinds one request can filter by. */
export const MAX_FILTERS = 50;

const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

const list = (value: string | null) => (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);

/** The query of `GET /events`, checked; throws what is wrong with it. */
export function eventsQuery(params: URLSearchParams): Query {
  const query: Query = {};
  const since = params.get("since");
  if (since !== null && since !== "") {
    if (/^\d{1,15}$/.test(since)) query.since = { id: Number(since) };
    else if (ISO.test(since) && !Number.isNaN(Date.parse(since))) query.since = { time: Date.parse(since) };
    else throw new Error("since must be an event id, such as the next of an earlier answer, or a time in ISO 8601, such as 2026-11-19T00:00:00Z.");
  }
  const kinds = list(params.get("kinds"));
  if (kinds.length > MAX_FILTERS) throw new Error(`kinds can name at most ${MAX_FILTERS} kinds.`);
  const unknown = kinds.filter((kind) => !knownKind(kind));
  if (unknown.length) throw new Error(`Unknown kind${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  if (kinds.length) query.kinds = kinds;
  const tokens = list(params.get("tokens"));
  if (tokens.length > MAX_FILTERS) throw new Error(`tokens can name at most ${MAX_FILTERS} tokens.`);
  if (tokens.some((token) => token.length > 80)) throw new Error("Each token is a contract address, a symbol or BitGo's id for it, at most 80 characters.");
  if (tokens.length) query.tokens = tokens;
  const limit = params.get("limit");
  if (limit !== null && limit !== "") {
    if (!/^\d{1,4}$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_LIMIT) throw new Error(`limit must be a whole number from 1 to ${MAX_LIMIT}; without it the answer holds up to ${DEFAULT_LIMIT} events.`);
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

/**
 * Serves the log, read only: `GET /events` and `GET /health`, and nothing else. Answers are JSON, and `/health` answers 503
 * while a source is failing.
 */
export function serveEvents(log: EventLog, health: () => Health, clock: () => number = Date.now): Server {
  return createServer((request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(`${JSON.stringify(value)}\n`);
    };
    if (request.method !== "GET" && request.method !== "HEAD") return send(405, { error: "Only GET is served." });
    const url = new URL(request.url ?? "/", "http://watcher");
    if (url.pathname === "/health") {
      const state = health();
      return send(state.ok ? 200 : 503, state);
    }
    if (url.pathname !== "/events") return send(404, { error: "Not found. The watcher serves GET /events and GET /health." });
    try {
      const page = log.query(eventsQuery(url.searchParams));
      return send(200, { readAt: new Date(clock()).toISOString(), ...page });
    } catch (error) {
      return send(400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
