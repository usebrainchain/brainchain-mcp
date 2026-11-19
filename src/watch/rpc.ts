import { createPublicClient, fallback, http } from "viem";

import { paced, RETRY_MS, type ChainHistory } from "../history.js";
import { ROBINHOOD_RPC } from "../premiums.js";
import type { Requests } from "./http.js";

/** Where the watcher reads Robinhood Chain from, in place of the public endpoint, which stays the fallback. */
export const RPC_SETTING = "BRAINCHAIN_WATCH_RPC";
/** The public endpoint turns away an address that reads in bursts, so its requests go out this far apart. */
export const PUBLIC_GAP_MS = 300;
export const PRIVATE_GAP_MS = 50;

/** The RPC setting, checked. Its value can hold a key, so no message repeats it. */
export function rpcSetting(value: string | undefined): URL | undefined {
  const given = value?.trim();
  if (!given) return undefined;
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new Error(`${RPC_SETTING} must be an https URL.`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`${RPC_SETTING} must be an https URL, or http on localhost: it can hold a key.`);
  return url;
}

/** The most blocks Chainstack's endpoint searches for logs in one request (read 2026-11-19). */
export const PRIVATE_SPAN = 10_000n;
/** A log search up to this many blocks is split into `PRIVATE_SPAN` pieces on the private endpoint; a longer one goes to the public endpoint, which searches ten million at a time. */
export const MAX_SPLIT = 200_000n;
/** The public endpoint's own limit on logs in one answer, kept when pieces are joined, so a caller halves a full range as before. */
const MAX_LOGS = 10_000;

/**
 * A fetch for an endpoint that searches at most `PRIVATE_SPAN` blocks for logs: a log search over more, up to `MAX_SPLIT`,
 * is sent as pieces and answered as one, and anything else is sent as it is. A piece that fails fails the whole, so the
 * fallback takes it to the public endpoint.
 */
export function splitting(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const call = typeof init?.body === "string" ? (JSON.parse(init.body) as { id?: unknown; method?: unknown; params?: [Record<string, unknown>] }) : undefined;
    const filter = call?.method === "eth_getLogs" ? call.params?.[0] : undefined;
    const [from, to] = [filter?.fromBlock, filter?.toBlock].map((block) => (typeof block === "string" && /^0x[0-9a-f]+$/i.test(block) ? BigInt(block) : undefined));
    if (!call || !filter || from === undefined || to === undefined || to - from + 1n <= PRIVATE_SPAN || to - from + 1n > MAX_SPLIT) return fetchImpl(input, init);
    const logs: unknown[] = [];
    for (let low = from; low <= to; low += PRIVATE_SPAN) {
      const high = low + PRIVATE_SPAN - 1n < to ? low + PRIVATE_SPAN - 1n : to;
      const body = JSON.stringify({ ...call, params: [{ ...filter, fromBlock: `0x${low.toString(16)}`, toBlock: `0x${high.toString(16)}` }] });
      const answer = await fetchImpl(input, { ...init, body });
      if (!answer.ok) return answer;
      const piece = (await answer.json()) as { result?: unknown[]; error?: unknown };
      if (!Array.isArray(piece.result)) return Response.json(piece);
      logs.push(...piece.result);
      if (logs.length > MAX_LOGS) return Response.json({ jsonrpc: "2.0", id: call.id, error: { code: -32005, message: `logs matched by query exceeds limit of ${MAX_LOGS}` } });
    }
    return Response.json({ jsonrpc: "2.0", id: call.id, result: logs });
  };
}

/**
 * A reader for Robinhood Chain: the RPC in the setting first, and the public endpoint when it fails, refuses a range it
 * does not serve, or is held back after a 429. Without the setting, the public endpoint alone.
 */
export function chainReader(requests: Requests, primary?: URL): ChainHistory {
  const transport = (url: string, fetchImpl: typeof fetch, gap: number) => http(url, { fetchFn: paced(fetchImpl, gap), retryCount: 2, retryDelay: RETRY_MS, timeout: 30_000 });
  const publicEndpoint = transport(ROBINHOOD_RPC, requests.fetchFor("chain"), PUBLIC_GAP_MS);
  if (!primary) return createPublicClient({ transport: publicEndpoint });
  return createPublicClient({ transport: fallback([transport(primary.href, splitting(requests.fetchFor("chain")), PRIVATE_GAP_MS), publicEndpoint], { retryCount: 1 }) });
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces every form of a secret URL in a message, so no log line or answer shows a node's address: a URL on its host,
 * with or without a port or a user name, and the key wherever it appears on its own, in its path, its query or its password.
 */
export function redactor(...secrets: (URL | undefined)[]): (text: string) => string {
  const urls = secrets.filter((url): url is URL => url !== undefined);
  if (urls.length === 0) return (text) => text;
  const hosts = urls.map((url) => escaped(url.hostname)).join("|");
  const pattern = new RegExp(`(?:https?://)?(?:[^\\s/@"'<>]*@)?(?:${hosts})(?::\\d+)?[^\\s"'<>]*`, "gi");
  const parts = urls.flatMap((url) => [url.password, url.username, ...url.pathname.split("/"), ...[...url.searchParams.values()]].filter((part) => part.length >= 8));
  return (text) => parts.reduce((redacted, part) => redacted.split(part).join("[redacted]"), text.replace(pattern, "the configured RPC"));
}
