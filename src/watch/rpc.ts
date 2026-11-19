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

/**
 * A reader for Robinhood Chain: the RPC in the setting first, and the public endpoint when it fails, refuses a range it
 * does not serve, or is held back after a 429. Without the setting, the public endpoint alone.
 */
export function chainReader(requests: Requests, primary?: URL): ChainHistory {
  const transport = (url: string, gap: number) => http(url, { fetchFn: paced(requests.fetchFor("chain"), gap), retryCount: 2, retryDelay: RETRY_MS, timeout: 15_000 });
  const publicEndpoint = transport(ROBINHOOD_RPC, PUBLIC_GAP_MS);
  return createPublicClient({ transport: primary ? fallback([transport(primary.href, PRIVATE_GAP_MS), publicEndpoint], { retryCount: 1 }) : publicEndpoint });
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
