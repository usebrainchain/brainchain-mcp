import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

import type { WatchEvent } from "../watch/events.js";
import { CHECKPOINT_FILE, POOLS_FILE, type IndexedPool, type PoolCheckpoint } from "../watch/pools.js";

const REQUEST_MS = 60_000;
const HEADERS = { Accept: "application/json", "User-Agent": "brainchain-mcp" };

async function getJson(url: URL | string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, { headers: HEADERS, redirect: "error", signal: AbortSignal.timeout(REQUEST_MS) });
  const body = await response.text();
  if (response.status !== 200) throw new Error(`${new URL(url).host} answered ${response.status}${response.status < 500 ? `: ${body.slice(0, 200)}` : ""}.`);
  return JSON.parse(body) as unknown;
}

const at = (watcher: URL, path: string) => new URL(path, watcher.href.endsWith("/") ? watcher : `${watcher.href}/`);

/** Every event the watcher has published, its baseline included, oldest first. */
export async function watcherEvents(watcher: URL, fetchImpl: typeof fetch = fetch): Promise<WatchEvent[]> {
  const events: WatchEvent[] = [];
  for (let since = 0; ; ) {
    const page = (await getJson(at(watcher, `events?since=${since}&limit=1000&baseline=1`), fetchImpl)) as { events?: WatchEvent[]; next?: number; more?: boolean };
    if (!Array.isArray(page.events) || typeof page.next !== "number") throw new Error(`The watcher at ${watcher.origin} did not answer with a page of events.`);
    events.push(...page.events);
    if (!page.more || page.next <= since) return events;
    since = page.next;
  }
}

/** A page of the pool index, and where the next starts. */
export interface PoolPage {
  pools: IndexedPool[];
  next: number;
  /** The index's length when read, and the block every pool through is in it. */
  bytes: number;
  through: number;
}

export interface PoolSource {
  /** Names the index, so a build that switches to another starts it from the beginning. */
  readonly name: string;
  page(after: number): Promise<PoolPage>;
}

/**
 * A pool index on this machine, as `brainchain-mcp watch` keeps it, read and never written: only what its checkpoint
 * stands behind, so a watcher writing to it at the same time is never read half way through a line.
 */
export function poolDir(dir: string): PoolSource {
  const file = join(dir, POOLS_FILE);
  const checkpoint = join(dir, CHECKPOINT_FILE);
  if (!existsSync(file) || !existsSync(checkpoint)) throw new Error(`${dir} holds no pool index: ${POOLS_FILE} and ${CHECKPOINT_FILE} are what brainchain-mcp watch keeps there.`);
  // One buffer for every page, so reading the whole index allocates nothing per page but the pools themselves.
  const chunk = Buffer.alloc(2 << 20);
  return {
    name: `dir:${dir}`,
    async page(after) {
      const { bytes, through } = JSON.parse(readFileSync(checkpoint, "utf8")) as PoolCheckpoint;
      if (after >= bytes) return { pools: [], next: after, bytes, through };
      const fd = openSync(file, "r");
      try {
        const read = readSync(fd, chunk, 0, Math.min(chunk.length, bytes - after), after);
        const text = chunk.toString("latin1", 0, read);
        const end = text.lastIndexOf("\n") + 1;
        if (end === 0) throw new Error(`${file} has a line longer than the pool index writes.`);
        const pools = text
          .slice(0, end)
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as IndexedPool);
        return { pools, next: after + end, bytes, through };
      } finally {
        closeSync(fd);
      }
    },
  };
}

/** The watcher's pool index, read through `GET /pools?after=`. */
export function poolWatcher(watcher: URL, fetchImpl: typeof fetch = fetch): PoolSource {
  return {
    name: watcher.origin,
    async page(after) {
      const page = (await getJson(at(watcher, `pools?after=${after}&limit=5000`), fetchImpl)) as Partial<PoolPage> & { ready?: boolean };
      if (!Array.isArray(page.pools) || typeof page.next !== "number" || typeof page.bytes !== "number" || typeof page.through !== "number") {
        throw new Error(`The watcher at ${watcher.origin} did not answer with a page of its pool index. It needs brainchain-mcp 0.16.0 or later and a private RPC.`);
      }
      if (page.ready === false) throw new Error(`The watcher at ${watcher.origin} is still filling its pool index, through block ${page.through}. Try again once it is done.`);
      return { pools: page.pools, next: page.next, bytes: page.bytes, through: page.through };
    },
  };
}

/** When KuCoin opened trading in each asset, in milliseconds, by its currency code: the earliest of its pairs. */
export async function kucoinStarts(fetchImpl: typeof fetch = fetch): Promise<Map<string, number>> {
  const body = (await getJson("https://api.kucoin.com/api/v2/symbols", fetchImpl)) as { data?: { baseCurrency?: unknown; tradingStartTime?: unknown }[] };
  if (!Array.isArray(body.data)) throw new Error("KuCoin did not answer with its list of pairs.");
  const starts = new Map<string, number>();
  for (const { baseCurrency, tradingStartTime } of body.data) {
    if (typeof baseCurrency !== "string" || typeof tradingStartTime !== "number" || tradingStartTime <= 0) continue;
    const code = baseCurrency.toUpperCase();
    if (!starts.has(code) || tradingStartTime < starts.get(code)!) starts.set(code, tradingStartTime);
  }
  return starts;
}

/** Gate writes 2020-01-01 or earlier in place of a start it does not give. */
const GATE_NO_START = Date.parse("2020-01-01T00:00:00Z") / 1000;

/** When Gate opened buying of each asset, in milliseconds, by its currency code: the earliest of its pairs. */
export async function gateStarts(fetchImpl: typeof fetch = fetch): Promise<Map<string, number>> {
  const pairs = (await getJson("https://api.gateio.ws/api/v4/spot/currency_pairs", fetchImpl)) as { base?: unknown; buy_start?: unknown }[];
  if (!Array.isArray(pairs)) throw new Error("Gate did not answer with its list of pairs.");
  const starts = new Map<string, number>();
  for (const { base, buy_start } of pairs) {
    if (typeof base !== "string" || typeof buy_start !== "number" || buy_start <= GATE_NO_START) continue;
    const code = base.toUpperCase();
    const ms = buy_start * 1000;
    if (!starts.has(code) || ms < starts.get(code)!) starts.set(code, ms);
  }
  return starts;
}
