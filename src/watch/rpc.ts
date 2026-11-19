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
    throw new Error(`${RPC_SETTING} must be an http or https URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${RPC_SETTING} must be an http or https URL.`);
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

/** Replaces every form of a secret URL in a message, whole or by its host, so no log line or answer shows a node's address. */
export function redactor(...secrets: (URL | undefined)[]): (text: string) => string {
  const hosts = secrets.filter((url): url is URL => url !== undefined).map((url) => url.host);
  if (hosts.length === 0) return (text) => text;
  const pattern = new RegExp(`(?:https?://)?(?:${hosts.map(escaped).join("|")})[^\\s"'<>]*`, "gi");
  return (text) => text.replace(pattern, "the configured RPC");
}
